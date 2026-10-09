//! `SlateDbKeyhiveStorage`: archives and events round-trip, stay apart from
//! each other and from the sedimentree data in the same database.

use std::sync::Arc;

use future_form::Sendable;
use object_store::{memory::InMemory, path::Path};
use subduction_keyhive::storage::{KeyhiveStorage, StorageHash};
use subduction_slatedb_storage::SlateDbStorage;

type Stored = Vec<(StorageHash, Vec<u8>)>;

fn sorted(mut items: Stored) -> Stored {
    items.sort_by_key(|(hash, _)| hash.to_hex());
    items
}

#[tokio::test]
async fn archives_and_events_roundtrip() -> testresult::TestResult {
    let storage = SlateDbStorage::open(Arc::new(InMemory::new()), Path::from("sync")).await?;
    let keyhive = storage.keyhive();
    let (a, b, c) = (
        StorageHash::new([1; 32]),
        StorageHash::new([2; 32]),
        StorageHash::new([3; 32]),
    );

    KeyhiveStorage::<Sendable>::save_archive(&keyhive, a, vec![1, 1]).await?;
    KeyhiveStorage::<Sendable>::save_event(&keyhive, b, vec![2, 2]).await?;
    KeyhiveStorage::<Sendable>::save_event(&keyhive, c, vec![3, 3]).await?;
    // same hash, different collection
    KeyhiveStorage::<Sendable>::save_event(&keyhive, a, vec![9]).await?;

    assert_eq!(
        KeyhiveStorage::<Sendable>::load_archives(&keyhive).await?,
        vec![(a, vec![1, 1])]
    );
    assert_eq!(
        sorted(KeyhiveStorage::<Sendable>::load_events(&keyhive).await?),
        vec![(a, vec![9]), (b, vec![2, 2]), (c, vec![3, 3])]
    );

    // another handle on the database sees the same state
    let other = storage.clone().keyhive();
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_events(&other).await?.len(),
        3
    );

    // an archive is replaced in place
    KeyhiveStorage::<Sendable>::save_archive(&keyhive, a, vec![7]).await?;
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_archives(&keyhive).await?,
        vec![(a, vec![7])]
    );

    KeyhiveStorage::<Sendable>::delete_event(&keyhive, b).await?;
    KeyhiveStorage::<Sendable>::delete_event(&keyhive, b).await?;
    KeyhiveStorage::<Sendable>::delete_archive(&keyhive, a).await?;
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_archives(&keyhive)
            .await?
            .len(),
        0
    );
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_events(&keyhive)
            .await?
            .len(),
        2
    );

    // keyhive keys are not sedimentree ids
    assert_eq!(
        subduction_core::storage::traits::Storage::<Sendable>::load_all_sedimentree_ids(&storage)
            .await?
            .len(),
        0
    );

    Ok(())
}

#[tokio::test]
async fn keyhive_directories_are_separate() -> testresult::TestResult {
    let storage = SlateDbStorage::open(Arc::new(InMemory::new()), Path::from("sync")).await?;
    let hash = StorageHash::new([5; 32]);
    KeyhiveStorage::<Sendable>::save_event(&storage.keyhive(), hash, vec![1]).await?;
    KeyhiveStorage::<Sendable>::save_event(&storage.keyhive_in("keyhive-0.6"), hash, vec![2])
        .await?;
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_events(&storage.keyhive()).await?,
        vec![(hash, vec![1])]
    );
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_events(&storage.keyhive_in("keyhive-0.6")).await?,
        vec![(hash, vec![2])]
    );
    Ok(())
}
