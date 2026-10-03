//! Object storage for Sedimentree.
//!
//! This crate provides [`ObjectStorage`], an implementation of the
//! [`Storage`](subduction_core::storage::traits::Storage) trait from
//! `subduction_core` on top of any [`object_store`] backend: Amazon S3 and
//! S3-compatible services (R2, Tigris, `MinIO`), a local directory, or memory.
//!
//! Everything lives in the bucket, so a server using this backend keeps no
//! sedimentree state on local disk and any number of servers can share one
//! bucket.
//!
//! # Layout
//!
//! ```text
//! {prefix}/
//! ├── ids/
//! │   └── {tree_hex}                       ← registration marker (empty)
//! └── trees/
//!     └── {tree_hex}/
//!         ├── commits/
//!         │   └── {commit_id_hex}/
//!         │       ├── {digest_hex}         ← tagged compound value
//!         │       └── {digest_hex}.blob    ← blob, when > inline threshold
//!         └── fragments/
//!             └── {head_id_hex}/
//!                 ├── {digest_hex}
//!                 └── {digest_hex}.blob
//!
//! tagged compound value:
//!   0x00 ++ meta_len:u32be ++ meta ++ blob    (inline)
//!   0x01 ++ meta                              (external)
//! ```
//!
//! `meta` is the `Signed<T>` wire bytes and `digest` is the content digest of
//! the payload, so several payloads sharing one
//! [`CommitId`](sedimentree_core::loose_commit::id::CommitId) (Byzantine
//! equivocation) coexist, and saving the same content twice overwrites an
//! object with identical bytes.
//!
//! Small blobs ride inline with their metadata so a save is one `PUT` and a
//! load is one `GET`. Large blobs are separate objects beside the item, so
//! metadata-only hydration never downloads them: the `LIST` that enumerates a
//! tree already reports each blob object's size, which is all that path needs
//! to confirm the blob is present.
//!
//! # Request cost
//!
//! | operation                 | requests                                     |
//! |---------------------------|----------------------------------------------|
//! | save one item             | 2 `PUT` (+1 for a large blob)                |
//! | save a batch of `n`       | `n + 1` `PUT` (+1 per large blob)            |
//! | is a tree registered?     | 1 `HEAD`                                     |
//! | hydrate a tree (metadata) | 1 `LIST` per 1000 objects + 1 `GET` per item |
//! | load a tree with blobs    | the above + 1 `GET` per large blob           |
//!
//! # Consistency
//!
//! Object stores have no transactions, so ordering stands in for them. A
//! large blob is written before the item that references it, and the
//! registration marker is written last: an item never points at a blob that
//! was not written, and a failed save never registers a tree. A crash between
//! steps leaves at most an unreferenced blob or an unregistered item, both of
//! which the next save of the same content completes.
//!
//! Loads tolerate what is left behind: an item that cannot be decoded, or
//! whose blob is missing or the wrong size, is skipped with a warning.
//!
//! The backend relies on read-after-write and list-after-write consistency,
//! which S3 and the S3-compatible stores named above provide.

mod codec;
mod error;
#[cfg(feature = "keyhive")]
mod keyhive;
mod storage;

use std::{collections::BTreeMap, sync::Arc};

use futures::{StreamExt, TryStreamExt, stream};
use object_store::{ObjectStore, ObjectStoreExt, PutPayload, path::Path};
use sedimentree_core::{
    blob::{Blob, has_meta::HasBlobMeta},
    codec::{decode::DecodeFields, encode::EncodeFields, schema::Schema},
    collections::Set,
    crypto::digest::Digest,
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_crypto::{signed::Signed, verified_meta::VerifiedMeta};
use url::Url;

use crate::codec::{DecodedCompound, decode_compound, encode_external, encode_inline, split_meta};
pub use crate::error::ObjectStorageError;
#[cfg(feature = "keyhive")]
pub use crate::keyhive::ObjectKeyhiveStorage;

/// Blobs up to this size are stored inline with their metadata.
pub const DEFAULT_INLINE_THRESHOLD: usize = 16 * 1024;

/// How many requests a bulk load or batch save keeps in flight.
pub const DEFAULT_CONCURRENCY: usize = 32;

const IDS_DIR: &str = "ids";
const TREES_DIR: &str = "trees";
const BLOB_SUFFIX: &str = ".blob";

/// Which of a tree's two item collections an operation addresses.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Kind {
    Commits,
    Fragments,
}

impl Kind {
    const fn dir(self) -> &'static str {
        match self {
            Self::Commits => "commits",
            Self::Fragments => "fragments",
        }
    }

    const fn what(self) -> &'static str {
        match self {
            Self::Commits => "loose commit",
            Self::Fragments => "fragment",
        }
    }
}

/// One stored item as a `LIST` reports it.
#[derive(Debug, Default)]
struct Listed {
    /// The compound value object exists.
    item: bool,

    /// Size of the external blob object, if there is one.
    blob_size: Option<u64>,
}

/// Items under a prefix keyed by `(item id hex, content digest hex)`, so
/// iteration follows the same `id ++ digest` order for every load path.
type Listing = BTreeMap<(String, String), Listed>;

/// Everything one save writes, resolved from a verified item.
struct PendingSave {
    item: Path,
    value: Vec<u8>,
    blob: Option<(Path, Vec<u8>)>,
}

/// [`Storage`](subduction_core::storage::traits::Storage) over an
/// [`ObjectStore`]. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ObjectStorage {
    store: Arc<dyn ObjectStore>,
    prefix: Path,
    inline_threshold: usize,
    concurrency: usize,
}

impl ObjectStorage {
    /// Store under `prefix` in `store`.
    #[must_use]
    pub fn new(store: Arc<dyn ObjectStore>, prefix: Path) -> Self {
        Self {
            store,
            prefix,
            inline_threshold: DEFAULT_INLINE_THRESHOLD,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }

    /// Open the store a URL names: `s3://bucket/prefix`, `file:///dir` or
    /// `memory:///`.
    ///
    /// `s3://` takes its credentials and endpoint from the environment
    /// (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
    /// `AWS_ENDPOINT_URL`, …), which is how S3-compatible services are
    /// addressed.
    ///
    /// # Errors
    ///
    /// Returns an error if the URL is not a supported object store URL or the
    /// store cannot be configured from it.
    pub fn from_url(url: &Url) -> Result<Self, ObjectStorageError> {
        #[cfg(feature = "aws")]
        if url.scheme() == "s3" {
            let store = object_store::aws::AmazonS3Builder::from_env()
                .with_url(url.as_str())
                .build()?;
            let prefix = Path::from_url_path(url.path())?;
            return Ok(Self::new(Arc::new(store), prefix));
        }

        let (store, prefix) = object_store::parse_url(url)?;
        Ok(Self::new(Arc::from(store), prefix))
    }

    /// Set the size above which a blob becomes its own object.
    #[must_use]
    pub const fn with_inline_threshold(mut self, inline_threshold: usize) -> Self {
        self.inline_threshold = inline_threshold;
        self
    }

    /// Set how many requests a bulk operation keeps in flight (at least 1).
    #[must_use]
    pub const fn with_concurrency(mut self, concurrency: usize) -> Self {
        self.concurrency = if concurrency == 0 { 1 } else { concurrency };
        self
    }

    fn id_path(&self, tree: SedimentreeId) -> Path {
        self.prefix
            .clone()
            .join(IDS_DIR)
            .join(hex::encode(tree.as_bytes()))
    }

    fn tree_path(&self, tree: SedimentreeId) -> Path {
        self.prefix
            .clone()
            .join(TREES_DIR)
            .join(hex::encode(tree.as_bytes()))
    }

    fn kind_path(&self, tree: SedimentreeId, kind: Kind) -> Path {
        self.tree_path(tree).join(kind.dir())
    }

    fn item_dir(&self, tree: SedimentreeId, kind: Kind, id: CommitId) -> Path {
        self.kind_path(tree, kind).join(hex::encode(id.as_bytes()))
    }

    // ==================== Registration ====================

    async fn register(&self, tree: SedimentreeId) -> Result<(), ObjectStorageError> {
        self.store
            .put(&self.id_path(tree), PutPayload::default())
            .await?;
        Ok(())
    }

    async fn is_registered(&self, tree: SedimentreeId) -> Result<bool, ObjectStorageError> {
        match self.store.head(&self.id_path(tree)).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    async fn registered_ids(&self) -> Result<Set<SedimentreeId>, ObjectStorageError> {
        let dir = self.prefix.clone().join(IDS_DIR);
        let mut objects = self.store.list(Some(&dir));
        let mut ids = Set::new();
        while let Some(object) = objects.try_next().await? {
            if let Some(bytes) = object.location.filename().and_then(decode_hex32) {
                ids.insert(SedimentreeId::new(bytes));
            } else {
                tracing::warn!(location = %object.location, "skipping unrecognised id marker");
            }
        }
        Ok(ids)
    }

    // ==================== Saving ====================

    fn pending(&self, dir: Path, digest: &[u8; 32], signed: &[u8], blob: Vec<u8>) -> PendingSave {
        let name = hex::encode(digest);
        let item = dir.clone().join(name.as_str());
        if blob.len() > self.inline_threshold {
            PendingSave {
                item,
                value: encode_external(signed),
                blob: Some((dir.join(format!("{name}{BLOB_SUFFIX}")), blob)),
            }
        } else {
            PendingSave {
                item,
                value: encode_inline(signed, &blob),
                blob: None,
            }
        }
    }

    fn pending_commit(
        &self,
        tree: SedimentreeId,
        verified: VerifiedMeta<LooseCommit>,
    ) -> PendingSave {
        let (signed, payload, blob) = verified.into_full_parts();
        let digest = Digest::hash(&payload);
        self.pending(
            self.item_dir(tree, Kind::Commits, payload.head()),
            digest.as_bytes(),
            signed.as_bytes(),
            blob.into_contents(),
        )
    }

    fn pending_fragment(
        &self,
        tree: SedimentreeId,
        verified: VerifiedMeta<Fragment>,
    ) -> PendingSave {
        let (signed, payload, blob) = verified.into_full_parts();
        let digest = Digest::hash(&payload);
        self.pending(
            self.item_dir(tree, Kind::Fragments, payload.head()),
            digest.as_bytes(),
            signed.as_bytes(),
            blob.into_contents(),
        )
    }

    /// Write one item: its blob object first, so the item never references a
    /// blob that was not written.
    async fn write(&self, pending: PendingSave) -> Result<(), ObjectStorageError> {
        if let Some((path, blob)) = pending.blob {
            self.store.put(&path, blob.into()).await?;
        }
        self.store.put(&pending.item, pending.value.into()).await?;
        Ok(())
    }

    /// Write items, then register the tree. The marker goes last so a failed
    /// write never leaves a registered tree behind.
    async fn save(
        &self,
        tree: SedimentreeId,
        pending: Vec<PendingSave>,
    ) -> Result<(), ObjectStorageError> {
        stream::iter(pending.into_iter().map(Ok))
            .try_for_each_concurrent(self.concurrency, |p| self.write(p))
            .await?;
        self.register(tree).await
    }

    // ==================== Loading ====================

    async fn list_items(&self, prefix: &Path, what: &str) -> Result<Listing, ObjectStorageError> {
        let mut objects = self.store.list(Some(prefix));
        let mut listing = Listing::new();
        while let Some(object) = objects.try_next().await? {
            let mut parts = object.location.parts().rev();
            let (Some(name), Some(id)) = (parts.next(), parts.next()) else {
                continue;
            };
            let (name, id) = (name.as_ref(), id.as_ref());
            let (digest, is_blob) = match name.strip_suffix(BLOB_SUFFIX) {
                Some(digest) => (digest, true),
                None => (name, false),
            };
            if decode_hex32(id).is_none() || decode_hex32(digest).is_none() {
                tracing::warn!(location = %object.location, "skipping unrecognised {what} object");
                continue;
            }
            let entry = listing
                .entry((id.to_owned(), digest.to_owned()))
                .or_default();
            if is_blob {
                entry.blob_size = Some(object.size);
            } else {
                entry.item = true;
            }
        }
        Ok(listing)
    }

    /// `GET` an object, with a missing one as `None`.
    async fn get(&self, path: &Path) -> Result<Option<Vec<u8>>, ObjectStorageError> {
        match self.store.get(path).await {
            Ok(result) => Ok(Some(result.bytes().await?.to_vec())),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Load one item with its blob. `None` (with a warning) when it is
    /// corrupt or its blob is missing or the wrong size.
    async fn load_item<T>(
        &self,
        dir: Path,
        digest: &str,
        what: &str,
    ) -> Result<Option<VerifiedMeta<T>>, ObjectStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let item = dir.clone().join(digest);
        let Some(value) = self.get(&item).await? else {
            return Ok(None);
        };
        let Some(decoded) = decode_compound(&value) else {
            tracing::warn!(location = %item, "skipping malformed {what}");
            return Ok(None);
        };

        let (meta, blob) = match decoded {
            DecodedCompound::Inline { meta, blob } => (meta, Some(blob)),
            DecodedCompound::External { meta } => (meta, None),
        };
        let signed: Signed<T> = match Signed::try_decode(&meta) {
            Ok(signed) => signed,
            Err(e) => {
                tracing::warn!(location = %item, "skipping corrupt stored {what}: {e}");
                return Ok(None);
            }
        };

        let blob = if let Some(blob) = blob {
            blob
        } else {
            let expected = match signed.try_decode_trusted_payload() {
                Ok(payload) => payload.blob_meta().size_bytes(),
                Err(e) => {
                    tracing::warn!(location = %item, "skipping corrupt stored {what}: {e}");
                    return Ok(None);
                }
            };
            let path = dir.join(format!("{digest}{BLOB_SUFFIX}"));
            let Some(blob) = self.get(&path).await? else {
                tracing::warn!(location = %path, "blob object missing; skipping {what}");
                return Ok(None);
            };
            if blob.len() as u64 != expected {
                tracing::warn!(
                    location = %path,
                    have = blob.len(),
                    need = expected,
                    "blob object size mismatch; skipping {what}"
                );
                return Ok(None);
            }
            blob
        };

        match VerifiedMeta::try_from_trusted(signed, Blob::new(blob)) {
            Ok(verified) => Ok(Some(verified)),
            Err(e) => {
                tracing::warn!(location = %item, "skipping corrupt stored {what}: {e}");
                Ok(None)
            }
        }
    }

    /// Load one item's payload without its blob. An external blob is checked
    /// against the listing (present, signed size) rather than read, so this
    /// skips exactly the items [`load_item`](Self::load_item) would.
    async fn load_meta<T>(
        &self,
        dir: Path,
        digest: &str,
        blob_size: Option<u64>,
        what: &str,
    ) -> Result<Option<T>, ObjectStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let item = dir.join(digest);
        let Some(value) = self.get(&item).await? else {
            return Ok(None);
        };
        let Some((is_external, meta)) = split_meta(&value) else {
            tracing::warn!(location = %item, "skipping malformed {what}");
            return Ok(None);
        };

        let payload = match Signed::<T>::try_decode(&meta)
            .and_then(|signed| signed.try_decode_trusted_payload())
        {
            Ok(payload) => payload,
            Err(e) => {
                tracing::warn!(location = %item, "skipping corrupt stored {what}: {e}");
                return Ok(None);
            }
        };

        if is_external {
            let need = payload.blob_meta().size_bytes();
            if blob_size != Some(need) {
                tracing::warn!(
                    location = %item,
                    have = ?blob_size,
                    need,
                    "blob object missing or size mismatch; skipping {what}"
                );
                return Ok(None);
            }
        }

        Ok(Some(payload))
    }

    /// Load a collection's items (or just those of one item id) with their
    /// blobs, in `id ++ digest` order.
    async fn load_items<T>(
        &self,
        tree: SedimentreeId,
        kind: Kind,
        only: Option<CommitId>,
    ) -> Result<Vec<VerifiedMeta<T>>, ObjectStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let what = kind.what();
        let prefix = match only {
            Some(id) => self.item_dir(tree, kind, id),
            None => self.kind_path(tree, kind),
        };
        let listing = self.list_items(&prefix, what).await?;
        let base = self.kind_path(tree, kind);

        let loaded: Vec<Option<VerifiedMeta<T>>> =
            stream::iter(listing.into_iter().filter(|(_, listed)| listed.item).map(
                |((id, digest), _)| {
                    let dir = base.clone().join(id);
                    async move { self.load_item(dir, &digest, what).await }
                },
            ))
            .buffered(self.concurrency)
            .try_collect()
            .await?;

        Ok(loaded.into_iter().flatten().collect())
    }

    /// Load every payload of a collection without blobs, in `id ++ digest`
    /// order.
    async fn load_metas<T>(
        &self,
        tree: SedimentreeId,
        kind: Kind,
    ) -> Result<Vec<T>, ObjectStorageError>
    where
        T: HasBlobMeta + Schema + EncodeFields + DecodeFields,
    {
        let what = kind.what();
        let base = self.kind_path(tree, kind);
        let listing = self.list_items(&base, what).await?;

        let loaded: Vec<Option<T>> =
            stream::iter(listing.into_iter().filter(|(_, listed)| listed.item).map(
                |((id, digest), listed)| {
                    let dir = base.clone().join(id);
                    async move { self.load_meta(dir, &digest, listed.blob_size, what).await }
                },
            ))
            .buffered(self.concurrency)
            .try_collect()
            .await?;

        Ok(loaded.into_iter().flatten().collect())
    }

    async fn list_ids(
        &self,
        tree: SedimentreeId,
        kind: Kind,
    ) -> Result<Set<CommitId>, ObjectStorageError> {
        let listing = self
            .list_items(&self.kind_path(tree, kind), kind.what())
            .await?;
        Ok(listing
            .into_iter()
            .filter(|(_, listed)| listed.item)
            .filter_map(|((id, _), _)| decode_hex32(&id).map(CommitId::new))
            .collect())
    }

    // ==================== Deleting ====================

    /// Delete every object under `prefix`.
    async fn delete_prefix(&self, prefix: &Path) -> Result<(), ObjectStorageError> {
        let locations = self
            .store
            .list(Some(prefix))
            .map_ok(|object| object.location)
            .boxed();
        let mut deleted = self.store.delete_stream(locations);
        loop {
            match deleted.try_next().await {
                Ok(Some(_)) | Err(object_store::Error::NotFound { .. }) => {}
                Ok(None) => return Ok(()),
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Unregister a tree and delete everything stored for it.
    async fn delete_tree(&self, tree: SedimentreeId) -> Result<(), ObjectStorageError> {
        match self.store.delete(&self.id_path(tree)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => return Err(e.into()),
        }
        self.delete_prefix(&self.tree_path(tree)).await
    }
}

/// Decode 64 hex characters into 32 bytes.
fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex, &mut out).ok()?;
    Some(out)
}
