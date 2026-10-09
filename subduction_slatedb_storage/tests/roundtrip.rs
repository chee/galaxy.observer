//! Save/load tests for `SlateDbStorage`, mirroring the `subduction_redb_storage`
//! suite and adding what is specific to SlateDB: separate metadata and blob
//! keys, atomic batches and one writer per database.

#![allow(clippy::indexing_slicing)]

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use future_form::Sendable;
use object_store::{ObjectStore, memory::InMemory, path::Path};
use sedimentree_core::{
    blob::{Blob, verified::VerifiedBlobMeta},
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_core::storage::{conformance, traits::Storage};
use subduction_crypto::{signer::memory::MemorySigner, verified_meta::VerifiedMeta};
use subduction_slatedb_storage::{
    SlateDbStorage,
    slatedb::{bytes::Bytes, config::Settings},
};
use url::Url;

fn test_signer() -> MemorySigner {
    MemorySigner::from_bytes(&[42u8; 32])
}

/// Flush the log often so durable writes return quickly.
fn settings() -> Settings {
    Settings {
        flush_interval: Some(Duration::from_millis(5)),
        ..SlateDbStorage::settings()
    }
}

async fn open(store: Arc<dyn ObjectStore>) -> Result<SlateDbStorage, Box<dyn std::error::Error>> {
    Ok(SlateDbStorage::open_with_settings(store, Path::from("sync"), settings()).await?)
}

async fn memory() -> Result<SlateDbStorage, Box<dyn std::error::Error>> {
    open(Arc::new(InMemory::new())).await
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

/// Every key in the database.
async fn keys(storage: &SlateDbStorage) -> Result<Vec<Bytes>, Box<dyn std::error::Error>> {
    let mut iter = storage.db().scan(..).await?;
    let mut keys = Vec::new();
    while let Some(kv) = iter.next().await? {
        keys.push(kv.key);
    }
    Ok(keys)
}

#[tokio::test]
async fn save_load_roundtrip() -> testresult::TestResult {
    let storage = memory().await?;
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

/// A blob of several MiB round-trips.
#[tokio::test]
async fn large_blobs_roundtrip() -> testresult::TestResult {
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x02; 32]);
    let head = CommitId::new([0x02; 32]);
    let large_blob: Vec<u8> = (0..5 * 1024 * 1024).map(|i: u32| (i % 251) as u8).collect();

    let fragment = seal_fragment(&signer, id, head, large_blob.clone()).await;
    Storage::<Sendable>::save_fragment(&storage, id, fragment).await?;

    let loaded = Storage::<Sendable>::load_fragment(&storage, id, head)
        .await?
        .ok_or("large fragment must load")?;
    assert_eq!(loaded.blob().contents(), &large_blob);

    Ok(())
}

/// Multiple commits round-trip; ids listed; per-tree isolation holds.
#[tokio::test]
async fn multiple_commits_and_isolation() -> testresult::TestResult {
    let storage = memory().await?;
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
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x03; 32]);
    let head = CommitId::new([0x10; 32]);

    let fragment = seal_fragment(&signer, id, head, vec![5; 256]).await;
    let original_signed = fragment.signed().as_bytes().to_vec();
    let commit = seal_commit(&signer, id, head, vec![6; 8]).await;

    let saved = Storage::<Sendable>::save_batch(&storage, id, vec![commit], vec![fragment]).await?;
    assert_eq!(saved, 2);

    let fragments = Storage::<Sendable>::load_fragments(&storage, id).await?;
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].signed().as_bytes(), &original_signed[..]);
    assert_eq!(fragments[0].blob().contents(), &vec![5; 256]);

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
    let storage = memory().await?;
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

/// Opening a database fences out its previous writer: the old handle's saves
/// fail and register nothing, and the new one sees everything the old one
/// saved. This is how a new deploy takes over from the old one.
#[tokio::test]
async fn newer_writer_fences_older() -> testresult::TestResult {
    let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let signer = test_signer();
    let saved = SedimentreeId::new([0x31; 32]);
    let refused = SedimentreeId::new([0x32; 32]);

    let old = open(store.clone()).await?;
    let commit = seal_commit(&signer, saved, CommitId::new([1; 32]), vec![1]).await;
    Storage::<Sendable>::save_loose_commit(&old, saved, commit).await?;

    let new = open(store).await?;
    let commit = seal_commit(&signer, refused, CommitId::new([2; 32]), vec![2]).await;
    assert!(
        Storage::<Sendable>::save_loose_commit(&old, refused, commit)
            .await
            .is_err(),
        "the fenced writer's save fails"
    );

    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&new, saved)
            .await?
            .len(),
        1
    );
    assert!(
        !Storage::<Sendable>::contains_sedimentree_id(&new, refused).await?,
        "a failed save registers nothing"
    );

    Ok(())
}

/// The metadata-only loads resolve to the same payloads as the full loads,
/// including for an equivocating id.
#[tokio::test]
async fn metas_match_full_load() -> testresult::TestResult {
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x41; 32]);
    let equivocated = CommitId::new([0x09; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; 4096]).await,
        seal_commit(&signer, id, equivocated, vec![3; 8]).await,
        seal_commit(&signer, id, equivocated, vec![4; 4096]).await,
    ];
    let fragments = vec![
        seal_fragment(&signer, id, CommitId::new([5; 32]), vec![5; 8]).await,
        seal_fragment(&signer, id, CommitId::new([6; 32]), vec![6; 4096]).await,
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

/// Metadata-only loads never read blob keys; a full load skips an item whose
/// blob is gone.
#[tokio::test]
async fn metadata_loads_skip_blobs() -> testresult::TestResult {
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x51; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; 8]).await,
    ];
    Storage::<Sendable>::save_batch(&storage, id, commits, Vec::new()).await?;

    // remove one blob behind the storage's back
    let blob = keys(&storage)
        .await?
        .into_iter()
        .find(|key| key[0] == b'C')
        .ok_or("a commit blob key")?;
    storage.db().delete(&blob).await?;

    assert_eq!(
        Storage::<Sendable>::load_loose_commit_metas(&storage, id)
            .await?
            .len(),
        2,
        "metadata loads don't look at blobs"
    );
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        1,
        "the full load skips the commit without a blob"
    );

    Ok(())
}

#[tokio::test]
async fn deletes() -> testresult::TestResult {
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x61; 32]);
    let other = SedimentreeId::new([0x62; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; 4096]).await,
        seal_commit(&signer, id, CommitId::new([3; 32]), vec![3; 8]).await,
    ];
    let fragments = vec![
        seal_fragment(&signer, id, CommitId::new([4; 32]), vec![4; 4096]).await,
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
    let commit_blobs = keys(&storage)
        .await?
        .iter()
        .filter(|key| key[0] == b'C' && key[1..33] == id.as_bytes()[..])
        .count();
    assert_eq!(commit_blobs, 2, "deleting a commit deletes its blob");

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

    let remaining = keys(&storage).await?;
    assert_eq!(
        remaining.len(),
        3,
        "only the other tree remains: {remaining:?}"
    );
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
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x71; 32]);

    let commits = vec![
        seal_commit(&signer, id, CommitId::new([1; 32]), vec![1; 8]).await,
        seal_commit(&signer, id, CommitId::new([2; 32]), vec![2; 4096]).await,
    ];
    let fragments = vec![seal_fragment(&signer, id, CommitId::new([3; 32]), vec![3; 8]).await];
    Storage::<Sendable>::save_batch(&storage, id, commits, fragments).await?;
    Storage::<Sendable>::delete_sedimentree_id(&storage, id).await?;

    assert_eq!(keys(&storage).await?.len(), 0);
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
    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x81; 32]);
    let head = CommitId::new([1; 32]);

    for _ in 0..2 {
        let verified = seal_commit(&signer, id, head, vec![1; 128]).await;
        Storage::<Sendable>::save_loose_commit(&storage, id, verified).await?;
    }

    // the tree, the commit's metadata and its blob
    assert_eq!(keys(&storage).await?.len(), 3);
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        1
    );

    Ok(())
}

/// Concurrent saves from many tasks all land.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_saves_all_land() -> testresult::TestResult {
    const COMMITS: u8 = 40;

    let storage = memory().await?;
    let signer = test_signer();
    let id = SedimentreeId::new([0x91; 32]);

    let mut set = tokio::task::JoinSet::new();
    for c in 0..COMMITS {
        let verified = seal_commit(&signer, id, CommitId::new([c; 32]), vec![c; 32]).await;
        let storage = storage.clone();
        set.spawn(
            async move { Storage::<Sendable>::save_loose_commit(&storage, id, verified).await },
        );
    }
    while let Some(joined) = set.join_next().await {
        joined??;
    }

    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        usize::from(COMMITS)
    );
    assert_eq!(
        Storage::<Sendable>::load_loose_commit_metas(&storage, id)
            .await?
            .len(),
        usize::from(COMMITS)
    );

    Ok(())
}

/// Data survives closing and reopening a database by URL, and a writer that
/// stopped without closing (its log is replayed).
#[tokio::test]
async fn survives_reopen_by_url() -> testresult::TestResult {
    let dir = tempfile::tempdir()?;
    let url = Url::from_directory_path(dir.path()).map_err(|()| "tempdir path is not a URL")?;
    let signer = test_signer();
    let id = SedimentreeId::new([0xA1; 32]);
    let (closed, crashed) = (CommitId::new([0x55; 32]), CommitId::new([0x56; 32]));

    let first = SlateDbStorage::from_url(&url).await?;
    let verified = seal_commit(&signer, id, closed, vec![7; 4096]).await;
    let original_signed = verified.signed().as_bytes().to_vec();
    Storage::<Sendable>::save_loose_commit(&first, id, verified).await?;
    first.close().await?;

    let second = SlateDbStorage::from_url(&url).await?;
    let verified = seal_commit(&signer, id, crashed, vec![8; 16]).await;
    Storage::<Sendable>::save_loose_commit(&second, id, verified).await?;
    // no close: the next open finds this save in the log

    let third = SlateDbStorage::from_url(&url).await?;
    let ids = Storage::<Sendable>::load_all_sedimentree_ids(&third).await?;
    assert!(ids.contains(&id), "tree id must survive reopen");
    let one = Storage::<Sendable>::load_loose_commit(&third, id, closed)
        .await?
        .ok_or("the commit saved before close must load")?;
    assert_eq!(one.signed().as_bytes(), &original_signed[..]);
    assert_eq!(one.blob().contents(), &vec![7; 4096]);
    assert!(
        Storage::<Sendable>::load_loose_commit(&third, id, crashed)
            .await?
            .is_some(),
        "the commit saved without close must load"
    );

    Ok(())
}

/// Never flush the log on a timer: only `close` (or a full buffer) uploads.
async fn open_unflushed(
    store: Arc<dyn ObjectStore>,
) -> Result<SlateDbStorage, Box<dyn std::error::Error>> {
    let settings = Settings {
        flush_interval: None,
        ..SlateDbStorage::settings()
    };
    Ok(SlateDbStorage::open_with_settings(store, Path::from("sync"), settings).await?)
}

/// A durable save waits for the upload; with no upload coming, it waits on.
#[tokio::test]
async fn durable_saves_wait_for_the_upload() -> testresult::TestResult {
    let storage = open_unflushed(Arc::new(InMemory::new())).await?;
    let id = SedimentreeId::new([0xC1; 32]);
    let commit = seal_commit(&test_signer(), id, CommitId::new([1; 32]), vec![1]).await;

    let save = Storage::<Sendable>::save_loose_commit(&storage, id, commit);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), save)
            .await
            .is_err(),
        "the save must not return before its upload"
    );

    Ok(())
}

/// A save that isn't durable returns at once and is visible to every read;
/// closing the database uploads it.
#[tokio::test]
async fn saves_in_memory_are_uploaded_on_close() -> testresult::TestResult {
    let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let storage = open_unflushed(store.clone())
        .await?
        .with_durable_saves(false);
    let id = SedimentreeId::new([0xC2; 32]);
    let commit = seal_commit(&test_signer(), id, CommitId::new([1; 32]), vec![1]).await;

    tokio::time::timeout(
        Duration::from_secs(5),
        Storage::<Sendable>::save_loose_commit(&storage, id, commit),
    )
    .await??;
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&storage, id)
            .await?
            .len(),
        1,
        "visible before it is durable"
    );
    storage.close().await?;

    let reopened = open(store).await?;
    assert_eq!(
        Storage::<Sendable>::load_loose_commits(&reopened, id)
            .await?
            .len(),
        1,
        "durable after close"
    );

    Ok(())
}

/// What a crash costs: a save still in memory when another writer takes over
/// is gone.
#[tokio::test]
async fn saves_in_memory_are_lost_without_close() -> testresult::TestResult {
    let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let crashed = open_unflushed(store.clone())
        .await?
        .with_durable_saves(false);
    let id = SedimentreeId::new([0xC3; 32]);
    let commit = seal_commit(&test_signer(), id, CommitId::new([1; 32]), vec![1]).await;
    Storage::<Sendable>::save_loose_commit(&crashed, id, commit).await?;

    let next = open(store).await?;
    assert!(!Storage::<Sendable>::contains_sedimentree_id(&next, id).await?);

    Ok(())
}
