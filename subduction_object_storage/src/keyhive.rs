//! Keyhive state in the same bucket as the sedimentree data.
//!
//! ```text
//! {prefix}/
//! └── keyhive/
//!     ├── archives/
//!     │   └── {hash_hex}    ← keyhive state snapshot
//!     └── ops/
//!         └── {hash_hex}    ← one keyhive event
//! ```
//!
//! Events are content-addressed, so servers sharing a bucket add to one set.
//! An archive is keyed by its owner's identity: servers that share a key seed
//! overwrite each other's snapshot, last writer wins. Nothing is lost that
//! way, since a snapshot is rebuilt from events, but servers meant to run
//! side by side on one bucket should each have their own key.

use std::sync::Arc;

use future_form::{FutureForm, Local, Sendable, future_form};
use futures::{StreamExt, TryStreamExt, stream};
use object_store::{ObjectStore, ObjectStoreExt, path::Path};
use subduction_keyhive::storage::{KeyhiveStorage, StorageHash};

use crate::{ObjectStorage, ObjectStorageError};

const KEYHIVE_DIR: &str = "keyhive";
const ARCHIVES_DIR: &str = "archives";
const OPS_DIR: &str = "ops";

/// [`KeyhiveStorage`] over an [`ObjectStore`]. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ObjectKeyhiveStorage {
    store: Arc<dyn ObjectStore>,
    prefix: Path,
    concurrency: usize,
}

impl ObjectStorage {
    /// Keyhive storage in the same store, under `{prefix}/keyhive`.
    #[must_use]
    pub fn keyhive(&self) -> ObjectKeyhiveStorage {
        self.keyhive_in(KEYHIVE_DIR)
    }

    /// Keyhive storage in the same store, under `{prefix}/{dir}`. Keyhive
    /// versions that can't read each other's events (`keyhive_core` 0.5 and
    /// 0.6) need separate directories.
    #[must_use]
    pub fn keyhive_in(&self, dir: &str) -> ObjectKeyhiveStorage {
        ObjectKeyhiveStorage {
            store: Arc::clone(&self.store),
            prefix: self.prefix.clone().join(dir),
            concurrency: self.concurrency,
        }
    }
}

impl ObjectKeyhiveStorage {
    fn path(&self, dir: &str, hash: StorageHash) -> Path {
        self.prefix.clone().join(dir).join(hash.to_hex())
    }

    async fn save(
        &self,
        dir: &str,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Result<(), ObjectStorageError> {
        self.store.put(&self.path(dir, hash), data.into()).await?;
        Ok(())
    }

    async fn load(&self, dir: &str) -> Result<Vec<(StorageHash, Vec<u8>)>, ObjectStorageError> {
        let mut objects = self.store.list(Some(&self.prefix.clone().join(dir)));
        let mut found = Vec::new();
        while let Some(object) = objects.try_next().await? {
            if let Some(hash) = object.location.filename().and_then(StorageHash::from_hex) {
                found.push((hash, object.location));
            } else {
                tracing::warn!(location = %object.location, "skipping unrecognised keyhive object");
            }
        }

        let loaded: Vec<Option<(StorageHash, Vec<u8>)>> =
            stream::iter(found.into_iter().map(|(hash, location)| async move {
                match self.store.get(&location).await {
                    Ok(result) => Ok(Some((hash, result.bytes().await?.to_vec()))),
                    // deleted between the listing and the read
                    Err(object_store::Error::NotFound { .. }) => Ok(None),
                    Err(e) => Err(ObjectStorageError::from(e)),
                }
            }))
            .buffered(self.concurrency)
            .try_collect()
            .await?;

        Ok(loaded.into_iter().flatten().collect())
    }

    async fn delete(&self, dir: &str, hash: StorageHash) -> Result<(), ObjectStorageError> {
        match self.store.delete(&self.path(dir, hash)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[future_form(Sendable, Local)]
impl<Async: FutureForm> KeyhiveStorage<Async> for ObjectKeyhiveStorage {
    type Error = ObjectStorageError;

    fn save_archive(
        &self,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.save(ARCHIVES_DIR, hash, data).await })
    }

    fn load_archives(&self) -> Async::Future<'_, Result<Vec<(StorageHash, Vec<u8>)>, Self::Error>> {
        Async::from_future(async move { self.load(ARCHIVES_DIR).await })
    }

    fn delete_archive(&self, hash: StorageHash) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.delete(ARCHIVES_DIR, hash).await })
    }

    fn save_event(
        &self,
        hash: StorageHash,
        data: Vec<u8>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.save(OPS_DIR, hash, data).await })
    }

    fn load_events(&self) -> Async::Future<'_, Result<Vec<(StorageHash, Vec<u8>)>, Self::Error>> {
        Async::from_future(async move { self.load(OPS_DIR).await })
    }

    fn delete_event(&self, hash: StorageHash) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move { self.delete(OPS_DIR, hash).await })
    }
}
