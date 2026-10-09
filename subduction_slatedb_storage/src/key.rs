//! Keys. Each starts with a one-byte table tag, so a table is one contiguous
//! range of the keyspace, and within it everything of one tree (or one item
//! id) shares a prefix.
//!
//! ```text
//! t ++ tree_id                           → ()                   registered trees
//! c ++ tree_id ++ commit_id ++ digest    → Signed<LooseCommit>  bytes
//! C ++ tree_id ++ commit_id ++ digest    → blob
//! f ++ tree_id ++ head_id ++ digest      → Signed<Fragment>     bytes
//! F ++ tree_id ++ head_id ++ digest      → blob
//! ```
//!
//! An item's metadata and blob have the same key bar the tag, and both tables
//! sort the same way, so a tree's metadata can be scanned without touching its
//! blobs. The trailing content digest lets several payloads share one item id
//! (Byzantine equivocation).

use sedimentree_core::{id::SedimentreeId, loose_commit::id::CommitId};

pub(crate) const TREES: u8 = b't';

/// `tag ++ tree_id`.
pub(crate) type TreeKey = [u8; 33];

/// `tag ++ tree_id ++ item_id`.
pub(crate) type ItemPrefix = [u8; 65];

/// `tag ++ tree_id ++ item_id ++ digest`.
pub(crate) type ItemKey = [u8; 97];

/// Which of a tree's two item collections an operation addresses.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Kind {
    Commits,
    Fragments,
}

impl Kind {
    /// Tag of the table holding this kind's signed metadata.
    pub(crate) const fn metas(self) -> u8 {
        match self {
            Self::Commits => b'c',
            Self::Fragments => b'f',
        }
    }

    /// Tag of the table holding this kind's blobs.
    pub(crate) const fn blobs(self) -> u8 {
        match self {
            Self::Commits => b'C',
            Self::Fragments => b'F',
        }
    }

    pub(crate) const fn what(self) -> &'static str {
        match self {
            Self::Commits => "loose commit",
            Self::Fragments => "fragment",
        }
    }
}

pub(crate) fn tree_key(tag: u8, tree: SedimentreeId) -> TreeKey {
    let mut key = [0u8; 33];
    key[0] = tag;
    key[1..].copy_from_slice(tree.as_bytes());
    key
}

pub(crate) fn item_prefix(tag: u8, tree: SedimentreeId, id: CommitId) -> ItemPrefix {
    let mut key = [0u8; 65];
    key[..33].copy_from_slice(&tree_key(tag, tree));
    key[33..].copy_from_slice(id.as_bytes());
    key
}

pub(crate) fn item_key(tag: u8, tree: SedimentreeId, id: CommitId, digest: &[u8; 32]) -> ItemKey {
    let mut key = [0u8; 97];
    key[..65].copy_from_slice(&item_prefix(tag, tree, id));
    key[65..].copy_from_slice(digest);
    key
}

/// The tree id of a `t` key.
pub(crate) fn tree_of(key: &[u8]) -> Option<SedimentreeId> {
    let bytes: [u8; 32] = key.get(1..33)?.try_into().ok()?;
    Some(SedimentreeId::new(bytes))
}

/// The item id of an item key.
pub(crate) fn item_id_of(key: &[u8]) -> Option<CommitId> {
    let bytes: [u8; 32] = key.get(33..65)?.try_into().ok()?;
    Some(CommitId::new(bytes))
}
