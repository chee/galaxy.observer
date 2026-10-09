//! The crate error type.

use thiserror::Error;

/// Errors that can occur during SlateDB storage operations.
#[derive(Debug, Error)]
pub enum SlateDbStorageError {
    /// The database failed a read or write, or is closed (including by being
    /// fenced out by a newer writer).
    #[error(transparent)]
    Db(#[from] slatedb::Error),

    /// The object store a URL names could not be configured.
    #[error(transparent)]
    Store(#[from] object_store::Error),

    /// A URL's path is not a valid object store prefix.
    #[error(transparent)]
    Path(#[from] object_store::path::Error),
}
