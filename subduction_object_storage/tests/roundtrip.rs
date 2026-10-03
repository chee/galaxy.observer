//! Save/load tests for `ObjectStorage`, mirroring the `subduction_redb_storage`
//! suite and adding what is specific to object stores: blob objects, shared
//! buckets and the request ordering that stands in for transactions.

#![allow(
    clippy::indexing_slicing,
    clippy::case_sensitive_file_extension_comparisons
)]

use std::{collections::BTreeSet, sync::Arc};

use future_form::Sendable;
use futures::TryStreamExt;
use object_store::{
    ObjectStore, ObjectStoreExt, local::LocalFileSystem, memory::InMemory, path::Path,
};
use sedimentree_core::{
    blob::{Blob, verified::VerifiedBlobMeta},
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_core::storage::{conformance, traits::Storage};
use subduction_crypto::{signer::memory::MemorySigner, verified_meta::VerifiedMeta};
use subduction_object_storage::ObjectStorage;
use url::Url;

/// Small enough that the tests reach both the inline and the blob-object path.
const THRESHOLD: usize = 64;

fn test_signer() -> MemorySigner {
    MemorySigner::from_bytes(&[42u8; 32])
}

fn memory() -> (Arc<InMemory>, ObjectStorage) {
    let store = Arc::new(InMemory::new());
    let storage =
        ObjectStorage::new(store.clone(), Path::from("sync")).with_inline_threshold(THRESHOLD);
    (store, storage)
}

async fn seal_commit(
    signer: &MemorySigner,
    id: SedimentreeId,
    head: CommitId,
    blob: Vec<u8>,
) -> VerifiedMeta<LooseCommit> {
    let verified_blob = VerifiedBlobMeta::new(Blob::new(blob));
    VerifiedMeta::seal::<Sendable, _>(signer, (id, head, BTreeSet::new()), verified_blob).await
}

async fn seal_fragment(
    signer: &MemorySigner,
    id: SedimentreeId,
    head: CommitId,
    blob: Vec<u8>,
) -> VerifiedMeta<Fragment> {
    let verified_blob = VerifiedBlobMeta::new(Blob::new(blob));
    VerifiedMeta::seal::<Sendable, _>(
        signer,
        (
            id,
            head,
            BTreeSet::from([CommitId::new([0xF0; 32])]),
            vec![CommitId::new([0xF1; 32])],
        ),
        verified_blob,
    )
    .await
}

async fn object_names(store: &dyn ObjectStore) -> Result<Vec<String>, object_store::Error> {
    let mut names: Vec<String> = store
        .list(None)
        .map_ok(|object| object.location.to_string())
        .try_collect()
        .await?;
    names.sort();
    Ok(names)
}

/// Save a commit, reload via bulk + point lookups, verify byte identity.
#[tokio::test]
async fn save_load_roundtrip() -> testresult::TestResult {
    let (_, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x01; 32]);
    let head = CommitId::new([0x42; 32]);

    let verified = seal_commit(&signer, id, head, vec![1, 2, 3, 4, 5]).await;
    let original_signed = verified.signed().as_bytes().to_vec();
    let original_blob = verified.blob().contents().clone();

    Storage::<Sendable>::save_loose_commit(&storage, id, verified).await?;

    let all = Storage::<Sendable>::load_loose_commits(&storage, id).await?;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].signed().as_bytes(), &original_signed[..]);
    assert_eq!(all[0].blob().contents(), &original_blob);

    let one = Storage::<Sendable>::load_loose_commit(&storage, id, head)
        .await?
        .ok_or("commit must be loadable by id")?;
    assert_eq!(one.signed().as_bytes(), &original_signed[..]);

    assert!(
        Storage::<Sendable>::load_loose_commit(&storage, id, CommitId::new([0x43; 32]))
            .await?
            .is_none(),
        "an unknown commit id loads as None"
    );

    Ok(())
}

/// A blob over the inline threshold becomes its own object and still
/// round-trips; a small one stays inside the item object.
#[tokio::test]
async fn large_blobs_become_objects() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x02; 32]);
    let small = CommitId::new([0x01; 32]);
    let large = CommitId::new([0x02; 32]);
    let large_blob = vec![7u8; THRESHOLD * 10];

    let commits = vec![
        seal_commit(&signer, id, small, vec![1; THRESHOLD]).await,
        seal_commit(&signer, id, large, large_blob.clone()).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, Vec::new()).await?;

    let names = object_names(store.as_ref()).await?;
    let blobs: Vec<_> = names.iter().filter(|n| n.ends_with(".blob")).collect();
    assert_eq!(blobs.len(), 1, "only the large blob is its own object");
    assert!(blobs[0].contains(&hex::encode(large.as_bytes())));
    // two items, one blob, one id marker
    assert_eq!(names.len(), 4, "{names:?}");

    let loaded = Storage::<Sendable>::load_loose_commit(&storage, id, large)
        .await?
        .ok_or("large commit must load")?;
    assert_eq!(loaded.blob().contents(), &large_blob);

    Ok(())
}

/// Multiple commits round-trip; ids listed; per-tree isolation holds.
#[tokio::test]
async fn multiple_commits_and_isolation() -> testresult::TestResult {
    let (_, storage) = memory();
    let signer = test_signer();
    let tree_a = SedimentreeId::new([0xAA; 32]);
    let tree_b = SedimentreeId::new([0xBB; 32]);

    let mut expected = BTreeSet::new();
    for i in 0..5u8 {
        let head = CommitId::new([i; 32]);
        expected.insert(head);
        let verified = seal_commit(&signer, tree_a, head, vec![i; 100]).await;
        Storage::<Sendable>::save_loose_commit(&storage, tree_a, verified).await?;
    }

    let other = seal_commit(&signer, tree_b, CommitId::new([0xFE; 32]), vec![9; 16]).await;
    Storage::<Sendable>::save_loose_commit(&storage, tree_b, other).await?;

    let loaded: BTreeSet<_> = Storage::<Sendable>::load_loose_commits(&storage, tree_a)
        .await?
        .iter()
        .map(|v| v.payload().head())
        .collect();
    assert_eq!(
        loaded, expected,
        "tree_a scan must return exactly its own commits"
    );

    let listed: BTreeSet<_> = Storage::<Sendable>::list_commit_ids(&storage, tree_a)
        .await?
        .into_iter()
        .collect();
    assert_eq!(listed, expected);

    let ids = Storage::<Sendable>::load_all_sedimentree_ids(&storage).await?;
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&tree_a) && ids.contains(&tree_b));

    Ok(())
}

/// Commits and fragments are separate collections of one tree.
#[tokio::test]
async fn fragments_roundtrip_beside_commits() -> testresult::TestResult {
    let (_, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x03; 32]);
    let head = CommitId::new([0x10; 32]);

    let fragment = seal_fragment(&signer, id, head, vec![5; THRESHOLD * 4]).await;
    let original_signed = fragment.signed().as_bytes().to_vec();
    let commit = seal_commit(&signer, id, head, vec![6; 8]).await;

    let saved = Storage::<Sendable>::save_batch(&storage, id, vec![commit], vec![fragment]).await?;
    assert_eq!(saved, 2);

    let fragments = Storage::<Sendable>::load_fragments(&storage, id).await?;
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].signed().as_bytes(), &original_signed[..]);
    assert_eq!(fragments[0].blob().contents(), &vec![5; THRESHOLD * 4]);

    let one = Storage::<Sendable>::load_fragment(&storage, id, head)
        .await?
        .ok_or("fragment must be loadable by head")?;
    assert_eq!(one.signed().as_bytes(), &original_signed[..]);

    assert_eq!(
        Storage::<Sendable>::list_fragment_ids(&storage, id)
            .await?
            .len(),
        1
    );
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        1,
        "the fragment must not appear among the commits"
    );

    Ok(())
}

#[tokio::test]
async fn saves_register_the_tree_id() -> testresult::TestResult {
    let (_, storage) = memory();
    let signer = test_signer();

    let commit = seal_commit(
        &signer,
        SedimentreeId::new([0x21; 32]),
        CommitId::new([1; 32]),
        vec![1],
    )
    .await;
    conformance::assert_commit_save_registers_tree_id::<Sendable, _>(&storage, commit).await;

    let fragment = seal_fragment(
        &signer,
        SedimentreeId::new([0x22; 32]),
        CommitId::new([2; 32]),
        vec![2],
    )
    .await;
    conformance::assert_fragment_save_registers_tree_id::<Sendable, _>(&storage, fragment).await;

    let id = SedimentreeId::new([0x23; 32]);
    let commit = seal_commit(&signer, id, CommitId::new([3; 32]), vec![3]).await;
    conformance::assert_batch_save_registers_tree_id::<Sendable, _>(
        &storage,
        id,
        vec![commit],
        Vec::new(),
    )
    .await;

    let empty = SedimentreeId::new([0x24; 32]);
    Storage::<Sendable>::save_batch(&storage, empty, Vec::new(), Vec::new()).await?;
    assert!(
        Storage::<Sendable>::contains_sedimentree_id(&storage, empty).await?,
        "an empty batch still registers the id"
    );

    Ok(())
}

/// A save that cannot write its item must not register the tree.
#[tokio::test]
async fn failed_save_does_not_register() -> testresult::TestResult {
    let dir = tempfile::tempdir()?;
    // A file where the backend needs the `trees/` directory: item writes fail,
    // marker writes under `ids/` would still succeed.
    std::fs::write(dir.path().join("trees"), b"roadblock")?;
    let store = Arc::new(LocalFileSystem::new_with_prefix(dir.path())?);
    let storage = ObjectStorage::new(store, Path::default());

    let commit = seal_commit(
        &test_signer(),
        SedimentreeId::new([0x31; 32]),
        CommitId::new([1; 32]),
        vec![1],
    )
    .await;
    conformance::assert_failed_commit_save_does_not_register_tree_id::<Sendable, _>(
        &storage, commit,
    )
    .await;

    Ok(())
}

/// The metadata-only loads resolve to the same payloads as the full loads,
/// including for an equivocating id whose payloads straddle the threshold.
#[tokio::test]
async fn metas_match_full_load() -> testresult::TestResult {
    let (_, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x41; 32]);
    let equivocated = CommitId::new([0x09; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; THRESHOLD * 3]).await,
        seal_commit(&signer, id, equivocated, vec![3; 8]).await,
        seal_commit(&signer, id, equivocated, vec![4; THRESHOLD * 3]).await,
    ];
    let fragments = vec![
        seal_fragment(&signer, id, CommitId::new([5; 32]), vec![5; 8]).await,
        seal_fragment(&signer, id, CommitId::new([6; 32]), vec![6; THRESHOLD * 3]).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, fragments).await?;

    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        4,
        "equivocating payloads coexist"
    );
    assert_eq!(
        Storage::<Sendable>::list_commit_ids(&storage, id)
            .await?
            .len(),
        3
    );
    conformance::assert_metas_match_full_load::<Sendable, _>(&storage, id).await;

    Ok(())
}

/// An item whose blob object is gone or truncated is skipped by the full load
/// and the metadata-only load alike.
#[tokio::test]
async fn damaged_blob_objects_are_skipped() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x51; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; THRESHOLD * 2]).await,
        seal_commit(&signer, id, CommitId::new([3; 32]), vec![3; THRESHOLD * 2]).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, Vec::new()).await?;

    let blobs: Vec<Path> = store
        .list(None)
        .map_ok(|object| object.location)
        .try_filter(|location| std::future::ready(location.as_ref().ends_with(".blob")))
        .try_collect()
        .await?;
    assert_eq!(blobs.len(), 2);
    store.delete(&blobs[0]).await?;
    store.put(&blobs[1], vec![0u8; 3].into()).await?;

    let full = Storage::<Sendable>::load_loose_commits(&storage, id).await?;
    assert_eq!(full.len(), 1, "only the inline commit survives");
    assert_eq!(full[0].payload().head(), CommitId::new([1; 32]));
    conformance::assert_metas_match_full_load::<Sendable, _>(&storage, id).await;

    Ok(())
}

#[tokio::test]
async fn deletes() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x61; 32]);
    let other = SedimentreeId::new([0x62; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; THRESHOLD * 2]).await,
        seal_commit(&signer, id, CommitId::new([3; 32]), vec![3; 8]).await,
    ];
    let fragments = vec![
        seal_fragment(&signer, id, CommitId::new([4; 32]), vec![4; THRESHOLD * 2]).await,
        seal_fragment(&signer, id, CommitId::new([5; 32]), vec![5; 8]).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, fragments).await?;
    let kept = seal_commit(&signer, other, CommitId::new([1; 32]), vec![9; 8]).await;
    Storage::<Sendable>::save_loose_commit(&storage, other, kept).await?;

    Storage::<Sendable>::delete_loose_commit(&storage, id, CommitId::new([2; 32])).await?;
    assert_eq!(
        Storage::<Sendable>::list_commit_ids(&storage, id)
            .await?
            .len(),
        2
    );
    assert!(
        !object_names(store.as_ref())
            .await?
            .iter()
            .any(|n| n.contains("/commits/") && n.ends_with(".blob")),
        "deleting a commit deletes its blob object"
    );

    Storage::<Sendable>::delete_fragment(&storage, id, CommitId::new([4; 32])).await?;
    assert_eq!(
        Storage::<Sendable>::list_fragment_ids(&storage, id)
            .await?
            .len(),
        1
    );

    Storage::<Sendable>::delete_loose_commits(&storage, id).await?;
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        0
    );
    assert_eq!(
        Storage::<Sendable>::load_fragments(&storage, id)
            .await?
            .len(),
        1,
        "deleting commits leaves fragments"
    );
    assert!(Storage::<Sendable>::contains_sedimentree_id(&storage, id).await?);

    Storage::<Sendable>::delete_fragments(&storage, id).await?;
    assert_eq!(
        Storage::<Sendable>::load_fragments(&storage, id)
            .await?
            .len(),
        0
    );

    Storage::<Sendable>::delete_sedimentree_id(&storage, id).await?;
    assert!(!Storage::<Sendable>::contains_sedimentree_id(&storage, id).await?);
    // deleting what is already gone is not an error
    Storage::<Sendable>::delete_sedimentree_id(&storage, id).await?;
    Storage::<Sendable>::delete_loose_commit(&storage, id, CommitId::new([1; 32])).await?;

    let names = object_names(store.as_ref()).await?;
    assert_eq!(names.len(), 2, "only the other tree remains: {names:?}");
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, other)
            .await?
            .len(),
        1
    );

    Ok(())
}

/// Deleting a tree removes its registration together with its items.
#[tokio::test]
async fn delete_tree_removes_items() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x71; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; THRESHOLD * 2]).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, Vec::new()).await?;
    Storage::<Sendable>::delete_sedimentree_id(&storage, id).await?;

    assert_eq!(object_names(store.as_ref()).await?.len(), 0);
    assert_eq!(
        Storage::<Sendable>::load_all_sedimentree_ids(&storage)
            .await?
            .len(),
        0
    );

    Ok(())
}

/// Saving the same content twice is a no-op.
#[tokio::test]
async fn saves_are_idempotent() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0x81; 32]);
    let head = CommitId::new([1; 32]);

    for _ in 0..2 {
        let verified = seal_commit(&signer, id, head, vec![1; THRESHOLD * 2]).await;
        Storage::<Sendable>::save_loose_commit(&storage, id, verified).await?;
    }

    assert_eq!(object_names(store.as_ref()).await?.len(), 3);
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        1
    );

    Ok(())
}

/// Two handles on one bucket see each other's writes, and concurrent saves all
/// land: the property that lets several servers share a bucket.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handles_share_a_bucket() -> testresult::TestResult {
    const COMMITS: u8 = 40;

    let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let writer_a = ObjectStorage::new(store.clone(), Path::from("sync"));
    let writer_b = ObjectStorage::new(store.clone(), Path::from("sync"));
    let reader = ObjectStorage::new(store.clone(), Path::from("sync"));
    let elsewhere = ObjectStorage::new(store, Path::from("other"));
    let signer = test_signer();
    let id = SedimentreeId::new([0x91; 32]);

    let mut set = tokio::task::JoinSet::new();
    for c in 0..COMMITS {
        let verified = seal_commit(&signer, id, CommitId::new([c; 32]), vec![c; 32]).await;
        let storage = if c % 2 == 0 {
            writer_a.clone()
        } else {
            writer_b.clone()
        };
        set.spawn(
            async move { Storage::<Sendable>::save_loose_commit(&storage, id, verified).await },
        );
    }
    while let Some(joined) = set.join_next().await {
        joined??;
    }

    assert!(Storage::<Sendable>::contains_sedimentree_id(&reader, id).await?);
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&reader, id)
            .await?
            .len(),
        usize::from(COMMITS)
    );
    assert_eq!(
        Storage::<Sendable>::load_loose_commit_metas(&reader, id)
            .await?
            .len(),
        usize::from(COMMITS)
    );
    assert!(
        !Storage::<Sendable>::contains_sedimentree_id(&elsewhere, id).await?,
        "a different prefix is a different store"
    );

    Ok(())
}

/// Data survives reopening a store by URL.
#[tokio::test]
async fn survives_reopen_by_url() -> testresult::TestResult {
    let dir = tempfile::tempdir()?;
    let url = Url::from_directory_path(dir.path()).map_err(|()| "tempdir path is not a URL")?;
    let signer = test_signer();
    let id = SedimentreeId::new([0xA1; 32]);
    let head = CommitId::new([0x55; 32]);

    let original_signed;
    {
        let storage = ObjectStorage::from_url(&url)?.with_inline_threshold(THRESHOLD);
        let verified = seal_commit(&signer, id, head, vec![7; THRESHOLD * 2]).await;
        original_signed = verified.signed().as_bytes().to_vec();
        Storage::<Sendable>::save_loose_commit(&storage, id, verified).await?;
    }

    let reopened = ObjectStorage::from_url(&url)?;
    let ids = Storage::<Sendable>::load_all_sedimentree_ids(&reopened).await?;
    assert!(ids.contains(&id), "tree id must survive reopen");
    let all = Storage::<Sendable>::load_loose_commits(&reopened, id).await?;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].signed().as_bytes(), &original_signed[..]);
    assert_eq!(all[0].blob().contents(), &vec![7; THRESHOLD * 2]);

    Ok(())
}

/// A tree's registration marker is written by its first save only; later
/// saves in the same process skip it. Deleting the tree forgets that, so the
/// next save registers it again.
#[tokio::test]
async fn registration_is_written_once_per_tree() -> testresult::TestResult {
    let (store, storage) = memory();
    let signer = test_signer();
    let id = SedimentreeId::new([0xB1; 32]);
    let marker = Path::from(format!("sync/ids/{}", hex::encode(id.as_bytes())));

    let first = seal_commit(&signer, id, CommitId::new([1; 32]), vec![1]).await;
    Storage::<Sendable>::save_loose_commit(&storage, id, first).await?;
    assert!(
        store.head(&marker).await.is_ok(),
        "the first save registers"
    );

    // Remove the marker behind the storage's back: a second save must not
    // write it again, which shows the save skipped the PUT.
    store.delete(&marker).await?;
    let second = seal_commit(&signer, id, CommitId::new([2; 32]), vec![2]).await;
    Storage::<Sendable>::save_loose_commit(&storage, id, second).await?;
    assert!(
        store.head(&marker).await.is_err(),
        "later saves don't rewrite the marker"
    );
    assert!(
        Storage::<Sendable>::contains_sedimentree_id(&storage, id).await?,
        "the process remembers the tree is registered"
    );

    Storage::<Sendable>::delete_sedimentree_id(&storage, id).await?;
    assert!(!Storage::<Sendable>::contains_sedimentree_id(&storage, id).await?);
    let third = seal_commit(&signer, id, CommitId::new([3; 32]), vec![3]).await;
    Storage::<Sendable>::save_loose_commit(&storage, id, third).await?;
    assert!(
        store.head(&marker).await.is_ok(),
        "a deleted tree registers again"
    );

    Ok(())
}
