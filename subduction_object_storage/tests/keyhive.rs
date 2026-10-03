//! `ObjectKeyhiveStorage`: archives and events round-trip, stay apart from
//! each other and from the sedimentree data in the same bucket.

use std::sync::Arc;

use future_form::Sendable;
use object_store::{memory::InMemory, path::Path};
use subduction_keyhive::storage::{KeyhiveStorage, StorageHash};
use subduction_object_storage::ObjectStorage;

type Stored = Vec<(StorageHash, Vec<u8>)>;

fn sorted(mut items: Stored) -> Stored {
    items.sort_by_key(|(hash, _)| hash.to_hex());
    items
}

#[tokio::test]
async fn archives_and_events_roundtrip() -> testresult::TestResult {
    let store = Arc::new(InMemory::new());
    let storage = ObjectStorage::new(store.clone(), Path::from("sync"));
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

    // a second handle on the bucket sees the same state
    let other = ObjectStorage::new(store, Path::from("sync")).keyhive();
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
    assert!(
        KeyhiveStorage::<Sendable>::load_archives(&keyhive)
            .await?
            .is_empty()
    );
    assert_eq!(
        KeyhiveStorage::<Sendable>::load_events(&keyhive)
            .await?
            .len(),
        2
    );

    // keyhive objects are not sedimentree ids
    assert!(
        subduction_core::storage::traits::Storage::<Sendable>::load_all_sedimentree_ids(&storage)
            .await?
            .is_empty()
    );

    Ok(())
}
