//! The crate error type.

use thiserror::Error;

/// Errors that can occur during object storage operations.
#[derive(Debug, Error)]
pub enum ObjectStorageError {
    /// A request to the object store failed.
    #[error(transparent)]
    Store(#[from] object_store::Error),

    /// A URL's path is not a valid object store prefix.
    #[error(transparent)]
    Path(#[from] object_store::path::Error),
}
