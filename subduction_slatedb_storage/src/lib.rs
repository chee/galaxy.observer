//! [SlateDB] storage for Sedimentree.
//!
//! This crate provides [`SlateDbStorage`], an implementation of the
//! [`Storage`](subduction_core::storage::traits::Storage) trait from
//! `subduction_core` on a SlateDB database: an LSM tree kept entirely in an
//! object store (Amazon S3 and S3-compatible services such as R2, Tigris and
//! `MinIO`, a local directory, or memory). The server keeps nothing on local
//! disk.
//!
//! # Layout
//!
//! The database is one sorted keyspace, laid out as `subduction_redb_storage`
//! lays out its tables (see the `key` module):
//!
//! ```text
//! t ++ tree_id                           → ()                   registered trees
//! c ++ tree_id ++ commit_id ++ digest    → Signed<LooseCommit>  bytes
//! C ++ tree_id ++ commit_id ++ digest    → blob
//! f ++ tree_id ++ head_id ++ digest      → Signed<Fragment>     bytes
//! F ++ tree_id ++ head_id ++ digest      → blob
//! k ++ namespace ++ / ++ a|e ++ hash     → keyhive archive | event
//! ```
//!
//! Metadata and blobs are separate keys, so metadata-only hydration scans the
//! metadata range of a tree and never reads its blobs.
//!
//! # Writes
//!
//! Every save is one [`WriteBatch`]: an item's metadata, its blob and the
//! tree's registration land together or not at all, and `save_batch` is
//! atomic. A save returns once its batch is durable in the object store.
//! SlateDB gathers the writes of every tree into one write-ahead log object
//! per flush interval (100ms by default), so the number of `PUT`s follows
//! time, not traffic.
//!
//! [`with_durable_saves(false)`](SlateDbStorage::with_durable_saves) returns
//! from a save as soon as it is in memory, where every read already sees it,
//! instead of waiting up to a flush interval for the upload. A crash then
//! loses the saves of the last flush interval; [`close`](SlateDbStorage::close)
//! uploads them on a clean shutdown.
//!
//! # Reads
//!
//! A tree's metadata is one range scan, served from the in-memory memtable,
//! SlateDB's block cache, or a few ranged `GET`s of the sorted tables that
//! hold it. Loading a tree with blobs is two scans.
//!
//! # One writer
//!
//! A database has one writer. Opening it fences out the previous writer,
//! whose later writes fail; a new deploy takes over from the old one that
//! way. Servers that run side by side need their own prefixes.
//!
//! [SlateDB]: https://slatedb.io

mod error;
mod key;
#[cfg(feature = "keyhive")]
mod keyhive;
mod storage;

use std::{collections::HashMap, sync::Arc, time::Duration};

use object_store::{ObjectStore, path::Path};
use sedimentree_core::{
    blob::{Blob, has_meta::HasBlobMeta},
    codec::{decode::DecodeFields, encode::EncodeFields, schema::Schema},
    collections::Set,
    crypto::digest::Digest,
    id::SedimentreeId,
    loose_commit::id::CommitId,
};
pub use slatedb;
use slatedb::{
    Db, KeyValue, WriteBatch,
    bytes::Bytes,
    config::{ScanOptions, Settings},
};
use subduction_crypto::{signed::Signed, verified_meta::VerifiedMeta};
use url::Url;

pub use crate::error::SlateDbStorageError;
use crate::key::{Kind, TREES, item_id_of, item_key, item_prefix, tree_key, tree_of};
#[cfg(feature = "keyhive")]
pub use crate::keyhive::SlateDbKeyhiveStorage;

/// How many bytes a scan asks the object store for at a time.
const SCAN_READ_AHEAD: usize = 64 * 1024;

/// How often the database looks for a newer writer and for compactions.
const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// [`Storage`](subduction_core::storage::traits::Storage) on a [SlateDB]
/// database. Cheap to clone; clones share the database.
///
/// [SlateDB]: https://slatedb.io
#[derive(Clone)]
pub struct SlateDbStorage {
    db: Db,
    /// Saves wait until they are durable in the object store.
    durable: bool,
}

impl std::fmt::Debug for SlateDbStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlateDbStorage").finish_non_exhaustive()
    }
}

impl SlateDbStorage {
    /// The settings [`open`](Self::open) uses: SlateDB's defaults, polling
    /// for a newer writer and for compactions every 10 seconds rather than
    /// every second or five. An idle database then costs about one `GET` a
    /// second instead of three, and the only writer finds out it was fenced
    /// on its next write anyway.
    #[must_use]
    pub fn settings() -> Settings {
        let mut settings = Settings {
            manifest_poll_interval: POLL_INTERVAL,
            ..Settings::default()
        };
        if let Some(compactor) = settings.compactor_options.as_mut() {
            compactor.poll_interval = POLL_INTERVAL;
        }
        settings
    }

    /// Open (or create) the database under `path` in `store`, with
    /// [`settings`](Self::settings).
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened.
    pub async fn open(
        store: Arc<dyn ObjectStore>,
        path: Path,
    ) -> Result<Self, SlateDbStorageError> {
        Self::open_with_settings(store, path, Self::settings()).await
    }

    /// Open (or create) the database under `path` in `store`.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened.
    pub async fn open_with_settings(
        store: Arc<dyn ObjectStore>,
        path: Path,
        settings: Settings,
    ) -> Result<Self, SlateDbStorageError> {
        let db = Db::builder(path, store)
            .with_settings(settings)
            .build()
            .await?;
        Ok(Self { db, durable: true })
    }

    /// Open the database a URL names: `s3://bucket/prefix`, `file:///dir` or
    /// `memory:///`.
    ///
    /// `s3://` takes its credentials and endpoint from the environment
    /// (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
    /// `AWS_ENDPOINT_URL`, …), which is how S3-compatible services are
    /// addressed. With `AWS_VIRTUAL_HOSTED_STYLE_REQUEST=true` the endpoint
    /// may be the service's base endpoint, as the AWS SDKs take it: the
    /// bucket is put in front of its host.
    ///
    /// # Errors
    ///
    /// Returns an error if the URL is not a supported object store URL, the
    /// store cannot be configured from it, or the database cannot be opened.
    pub async fn from_url(url: &Url) -> Result<Self, SlateDbStorageError> {
        let (store, path) = store_from_url(url)?;
        Self::open(store, path).await
    }

    /// Upload what is in memory and close the database. Saves that are not
    /// durable yet become durable; otherwise this spares the next open from
    /// replaying the log (up to 4096 objects, fetched in parallel).
    ///
    /// # Errors
    ///
    /// Returns an error if the final flush fails.
    pub async fn close(&self) -> Result<(), SlateDbStorageError> {
        self.db.close().await?;
        Ok(())
    }

    /// Whether a save waits until it is durable in the object store (the
    /// default) or returns once it is in memory.
    ///
    /// In memory, a save is already visible to every read, so the server
    /// forwards it to subscribers at once; it reaches the object store with
    /// the next log flush. A crash before then loses it from the server.
    /// Peers that still hold it send it again on their next sync, since the
    /// server asks for what it lacks.
    ///
    /// Keyhive state is always saved durably.
    #[must_use]
    pub const fn with_durable_saves(mut self, durable: bool) -> Self {
        self.durable = durable;
        self
    }

    /// The underlying database.
    #[must_use]
    pub const fn db(&self) -> &Db {
        &self.db
    }

    // ==================== Scanning ====================

    /// Every key-value pair under `prefix`, in key order.
    async fn scan(&self, prefix: &[u8]) -> Result<Vec<KeyValue>, SlateDbStorageError> {
        let mut iter = self
            .db
            .scan_prefix_with_options(prefix, .., &scan_options())
            .await?;
        let mut found = Vec::new();
        while let Some(kv) = iter.next().await? {
            found.push(kv);
        }
        Ok(found)
    }

    // ==================== Registration ====================

    async fn is_registered(&self, tree: SedimentreeId) -> Result<bool, SlateDbStorageError> {
        Ok(self.db.get(tree_key(TREES, tree)).await?.is_some())
    }

    async fn registered_ids(&self) -> Result<Set<SedimentreeId>, SlateDbStorageError> {
        Ok(self
            .scan(&[TREES])
            .await?
            .iter()
            .filter_map(|kv| tree_of(&kv.key))
            .collect())
    }

    // ==================== Saving ====================

    /// Write `batch` with the tree's registration, durably.
    async fn save(
        &self,
        tree: SedimentreeId,
        mut batch: WriteBatch,
    ) -> Result<(), SlateDbStorageError> {
        batch.put(tree_key(TREES, tree), []);
        self.write(batch).await
    }

    /// Write `batch`, and wait until it is durable in the object store
    /// unless saves are not durable.
    async fn write(&self, batch: WriteBatch) -> Result<(), SlateDbStorageError> {
        let written = self.db.write(batch).await?;
        if self.durable {
            written.await_durable().await?;
        }
        Ok(())
    }

    // ==================== Loading ====================

    /// The prefix of a tree's items of one kind, or of one item id's.
    fn prefix(tag: u8, tree: SedimentreeId, only: Option<CommitId>) -> Vec<u8> {
        match only {
            Some(id) => item_prefix(tag, tree, id).to_vec(),
            None => tree_key(tag, tree).to_vec(),
        }
    }

    /// Load a tree's items of one kind (or just those of one item id) with
    /// their blobs, in `id ++ digest` order. An item whose blob is missing
    /// or the wrong size is skipped with a warning.
    async fn load_items<T>(
        &self,
        tree: SedimentreeId,
        kind: Kind,
        only: Option<CommitId>,
    ) -> Result<Vec<VerifiedMeta<T>>, SlateDbStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let what = kind.what();
        let (metas, blobs) = (
            Self::prefix(kind.metas(), tree, only),
            Self::prefix(kind.blobs(), tree, only),
        );
        let (metas, blobs) = futures::try_join!(self.scan(&metas), self.scan(&blobs))?;
        // a blob's key is its item's key with the blob table's tag
        let mut blobs: HashMap<Bytes, Bytes> = blobs
            .into_iter()
            .map(|kv| (kv.key.slice(1..), kv.value))
            .collect();

        let mut loaded = Vec::with_capacity(metas.len());
        for kv in metas {
            let Some(signed) = decode_signed::<T>(&kv, what) else {
                continue;
            };
            let Some(blob) = blobs.remove(&kv.key.slice(1..)) else {
                tracing::warn!(key = ?kv.key, "blob missing; skipping {what}");
                continue;
            };
            let need = match signed.try_decode_trusted_payload() {
                Ok(payload) => payload.blob_meta().size_bytes(),
                Err(e) => {
                    tracing::warn!(key = ?kv.key, "skipping corrupt stored {what}: {e}");
                    continue;
                }
            };
            if blob.len() as u64 != need {
                tracing::warn!(key = ?kv.key, have = blob.len(), need, "blob size mismatch; skipping {what}");
                continue;
            }
            match VerifiedMeta::try_from_trusted(signed, Blob::new(blob.to_vec())) {
                Ok(verified) => loaded.push(verified),
                Err(e) => tracing::warn!(key = ?kv.key, "skipping corrupt stored {what}: {e}"),
            }
        }
        Ok(loaded)
    }

    /// Load a tree's payloads of one kind without their blobs, in
    /// `id ++ digest` order. Blobs are not read: an item's metadata and blob
    /// are written in one batch, so one is never there without the other.
    async fn load_metas<T>(
        &self,
        tree: SedimentreeId,
        kind: Kind,
    ) -> Result<Vec<T>, SlateDbStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let what = kind.what();
        Ok(self
            .scan(&tree_key(kind.metas(), tree))
            .await?
            .iter()
            .filter_map(|kv| {
                let signed = decode_signed::<T>(kv, what)?;
                signed
                    .try_decode_trusted_payload()
                    .inspect_err(|e| {
                        tracing::warn!(key = ?kv.key, "skipping corrupt stored {what}: {e}");
                    })
                    .ok()
            })
            .collect())
    }

    async fn list_ids(
        &self,
        tree: SedimentreeId,
        kind: Kind,
    ) -> Result<Set<CommitId>, SlateDbStorageError> {
        Ok(self
            .scan(&tree_key(kind.metas(), tree))
            .await?
            .iter()
            .filter_map(|kv| item_id_of(&kv.key))
            .collect())
    }

    // ==================== Deleting ====================

    /// Delete every key under each of `prefixes`, and `keys`, in one batch.
    async fn delete(
        &self,
        prefixes: &[Vec<u8>],
        keys: &[&[u8]],
    ) -> Result<(), SlateDbStorageError> {
        let mut batch = WriteBatch::new();
        for prefix in prefixes {
            for kv in self.scan(prefix).await? {
                batch.delete(kv.key);
            }
        }
        for key in keys {
            batch.delete(key);
        }
        // slatedb refuses an empty batch
        if batch.is_empty() {
            return Ok(());
        }
        self.write(batch).await
    }

    /// Delete a tree's items of one kind (or just those of one item id),
    /// metadata and blobs.
    async fn delete_items(
        &self,
        tree: SedimentreeId,
        kind: Kind,
        only: Option<CommitId>,
    ) -> Result<(), SlateDbStorageError> {
        self.delete(
            &[
                Self::prefix(kind.metas(), tree, only),
                Self::prefix(kind.blobs(), tree, only),
            ],
            &[],
        )
        .await
    }

    /// Unregister a tree and delete everything stored for it.
    async fn delete_tree(&self, tree: SedimentreeId) -> Result<(), SlateDbStorageError> {
        let prefixes = [Kind::Commits, Kind::Fragments]
            .into_iter()
            .flat_map(|kind| [kind.metas(), kind.blobs()])
            .map(|tag| tree_key(tag, tree).to_vec())
            .collect::<Vec<_>>();
        self.delete(&prefixes, &[&tree_key(TREES, tree)]).await
    }
}

/// How a scan reads the database's tables. SlateDB's defaults are for scans
/// over far more data than a tree has: one `GET` per block, and nothing
/// cached. A tree's items sit together, so reading ahead gets them in a
/// request or two, and the next sync of the same tree hits the cache.
fn scan_options() -> ScanOptions {
    ScanOptions {
        read_ahead_bytes: SCAN_READ_AHEAD,
        cache_blocks: true,
        ..ScanOptions::default()
    }
}

/// Put an item's metadata and blob into `batch`.
fn put_item<T>(
    batch: &mut WriteBatch,
    tree: SedimentreeId,
    kind: Kind,
    verified: VerifiedMeta<T>,
    head: impl FnOnce(&T) -> CommitId,
) where
    T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
{
    let (signed, payload, blob) = verified.into_full_parts();
    let digest = Digest::hash(&payload);
    let id = head(&payload);
    batch.put(
        item_key(kind.metas(), tree, id, digest.as_bytes()),
        signed.as_bytes(),
    );
    batch.put(
        item_key(kind.blobs(), tree, id, digest.as_bytes()),
        blob.contents(),
    );
}

/// Decode a stored item's metadata. `None` (with a warning) when corrupt.
fn decode_signed<T>(kv: &KeyValue, what: &str) -> Option<Signed<T>>
where
    T: Schema + EncodeFields + DecodeFields,
{
    Signed::try_decode(&kv.value)
        .inspect_err(|e| tracing::warn!(key = ?kv.key, "skipping corrupt stored {what}: {e}"))
        .ok()
}

/// The store and path a URL names.
fn store_from_url(url: &Url) -> Result<(Arc<dyn ObjectStore>, Path), SlateDbStorageError> {
    #[cfg(feature = "aws")]
    if url.scheme() == "s3" {
        use object_store::aws::{AmazonS3Builder, AmazonS3ConfigKey};

        let mut builder = AmazonS3Builder::from_env().with_url(url.as_str());
        let virtual_hosted = builder
            .get_config_value(&AmazonS3ConfigKey::VirtualHostedStyleRequest)
            .is_some_and(|v| v == "true");
        if virtual_hosted
            && let Some(bucket) = url.host_str()
            && let Some(endpoint) = builder.get_config_value(&AmazonS3ConfigKey::Endpoint)
            && let Some(endpoint) = virtual_hosted_endpoint(&endpoint, bucket)
        {
            builder = builder.with_endpoint(endpoint);
        }
        let path = Path::from_url_path(url.path())?;
        return Ok((Arc::new(builder.build()?), path));
    }

    let (store, path) = object_store::parse_url(url)?;
    Ok((Arc::from(store), path))
}

/// The virtual-hosted form of a base endpoint: `https://bucket.host` for
/// `https://host`. `None` when the endpoint already names the bucket (or is
/// not a URL with a host), in which case it is used as given.
#[cfg(feature = "aws")]
fn virtual_hosted_endpoint(endpoint: &str, bucket: &str) -> Option<String> {
    let mut url = Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    if host.starts_with(&format!("{bucket}.")) {
        return None;
    }
    let host = format!("{bucket}.{host}");
    url.set_host(Some(&host)).ok()?;
    Some(url.as_str().trim_end_matches('/').to_owned())
}

#[cfg(all(test, feature = "aws"))]
mod tests {
    use super::virtual_hosted_endpoint;

    #[test]
    fn base_endpoint_gains_the_bucket() {
        assert_eq!(
            virtual_hosted_endpoint("https://t3.storageapi.dev", "nebula-abc").as_deref(),
            Some("https://nebula-abc.t3.storageapi.dev")
        );
        assert_eq!(
            virtual_hosted_endpoint("http://localhost:9000/", "b").as_deref(),
            Some("http://b.localhost:9000")
        );
    }

    #[test]
    fn bucket_endpoint_is_left_alone() {
        assert_eq!(
            virtual_hosted_endpoint("https://nebula-abc.t3.storageapi.dev", "nebula-abc"),
            None
        );
        assert_eq!(virtual_hosted_endpoint("not a url", "b"), None);
    }
}
