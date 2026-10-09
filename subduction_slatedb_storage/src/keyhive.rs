//! Keyhive state in the same database as the sedimentree data.
//!
//! ```text
//! k ++ namespace ++ / ++ a ++ hash    → keyhive state snapshot (archive)
//! k ++ namespace ++ / ++ e ++ hash    → one keyhive event
//! ```
//!
//! The namespace keeps keyhive versions that can't read each other's events
//! apart.

use future_form::{FutureForm, Local, Sendable, future_form};
use slatedb::Db;
use subduction_keyhive::storage::{KeyhiveStorage, StorageHash};

use crate::{SlateDbStorage, SlateDbStorageError, scan_options};

const KEYHIVE: u8 = b'k';
const DEFAULT_NAMESPACE: &str = "keyhive";
const ARCHIVES: u8 = b'a';
const EVENTS: u8 = b'e';

/// [`KeyhiveStorage`] on a SlateDB database. Cheap to clone.
#[derive(Clone)]
pub struct SlateDbKeyhiveStorage {
    db: Db,
    /// `k ++ namespace ++ /`
    prefix: Vec<u8>,
}

impl std::fmt::Debug for SlateDbKeyhiveStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlateDbKeyhiveStorage")
            .field("prefix", &String::from_utf8_lossy(&self.prefix))
            .finish_non_exhaustive()
    }
}

impl SlateDbStorage {
    /// Keyhive storage in the same database, in the `keyhive` namespace.
    #[must_use]
    pub fn keyhive(&self) -> SlateDbKeyhiveStorage {
        self.keyhive_in(DEFAULT_NAMESPACE)
    }

    /// Keyhive storage in the same database, in `namespace`, which must not
    /// contain `/`. Keyhive versions that can't read each other's events
    /// need separate namespaces.
    ///
    /// # Panics
    ///
    /// Panics if `namespace` contains `/`.
    #[must_use]
    pub fn keyhive_in(&self, namespace: &str) -> SlateDbKeyhiveStorage {
        assert!(
            !namespace.contains('/'),
            "keyhive namespace {namespace:?} contains '/'"
        );
        let mut prefix = vec![KEYHIVE];
        prefix.extend_from_slice(namespace.as_bytes());
        prefix.push(b'/');
        SlateDbKeyhiveStorage {
            db: self.db.clone(),
            prefix,
        }
    }
}

impl SlateDbKeyhiveStorage {
    fn collection(&self, kind: u8) -> Vec<u8> {
        let mut prefix = self.prefix.clone();
        prefix.push(kind);
        prefix
    }

    fn key(&self, kind: u8, hash: StorageHash) -> Vec<u8> {
        let mut key = self.collection(kind);
        key.extend_from_slice(hash.as_bytes());
        key
    }

    async fn save(
        &self,
        kind: u8,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Result<(), SlateDbStorageError> {
        self.db
            .put(self.key(kind, hash), data)
            .await?
            .await_durable()
            .await?;
        Ok(())
    }

    async fn load(&self, kind: u8) -> Result<Vec<(StorageHash, Vec<u8>)>, SlateDbStorageError> {
        let prefix = self.collection(kind);
        let mut iter = self
            .db
            .scan_prefix_with_options(&prefix, .., &scan_options())
            .await?;
        let mut found = Vec::new();
        while let Some(kv) = iter.next().await? {
            if let Some(hash) = kv
                .key
                .get(prefix.len()..)
                .and_then(|hash| <[u8; 32]>::try_from(hash).ok())
            {
                found.push((StorageHash::new(hash), kv.value.to_vec()));
            } else {
                tracing::warn!(key = ?kv.key, "skipping unrecognised keyhive key");
            }
        }
        Ok(found)
    }

    async fn delete(&self, kind: u8, hash: StorageHash) -> Result<(), SlateDbStorageError> {
        self.db
            .delete(self.key(kind, hash))
            .await?
            .await_durable()
            .await?;
        Ok(())
    }
}

#[future_form(Sendable, Local)]
impl<Async: FutureForm> KeyhiveStorage<Async> for SlateDbKeyhiveStorage {
    type Error = SlateDbStorageError;

    fn save_archive(
        &self,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.save(ARCHIVES, hash, data).await })
    }

    fn load_archives(&self) -> Async::Future<'_, Result<Vec<(StorageHash, Vec<u8>)>, Self::Error>> {
        Async::from_future(async move { self.load(ARCHIVES).await })
    }

    fn delete_archive(&self, hash: StorageHash) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.delete(ARCHIVES, hash).await })
    }

    fn save_event(
        &self,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.save(EVENTS, hash, data).await })
    }

    fn load_events(&self) -> Async::Future<'_, Result<Vec<(StorageHash, Vec<u8>)>, Self::Error>> {
        Async::from_future(async move { self.load(EVENTS).await })
    }

    fn delete_event(&self, hash: StorageHash) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.delete(EVENTS, hash).await })
    }
}
