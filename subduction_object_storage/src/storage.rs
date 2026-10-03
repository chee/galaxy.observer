//! `impl Storage<Async> for ObjectStorage` for both [`Sendable`] and [`Local`]
//! future forms, written once and expanded by the [`future_form`] macro.

use future_form::{FutureForm, Local, Sendable, future_form};
use sedimentree_core::{
    collections::Set,
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_core::storage::traits::Storage;
use subduction_crypto::verified_meta::VerifiedMeta;

use crate::{Kind, ObjectStorage, ObjectStorageError};

#[future_form(Sendable, Local)]
impl<Async: FutureForm> Storage<Async> for ObjectStorage {
    type Error = ObjectStorageError;

    // ==================== Sedimentree IDs ====================

    fn save_sedimentree_id(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::save_sedimentree_id");
            self.register(sedimentree_id).await
        })
    }

    fn delete_sedimentree_id(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::delete_sedimentree_id");
            self.delete_tree(sedimentree_id).await
        })
    }

    fn load_all_sedimentree_ids(
        &self,
    ) -> Async::Future<'_, Result<Set<SedimentreeId>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!("ObjectStorage::load_all_sedimentree_ids");
            self.registered_ids().await
        })
    }

    fn contains_sedimentree_id(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<bool, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::contains_sedimentree_id");
            self.is_registered(sedimentree_id).await
        })
    }

    // ==================== Loose Commits (compound with blob) ====================

    fn save_loose_commit(
        &self,
        sedimentree_id: SedimentreeId,
        verified: VerifiedMeta<LooseCommit>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::save_loose_commit");
            let pending = self.pending_commit(sedimentree_id, verified);
            self.save(sedimentree_id, vec![pending]).await
        })
    }

    fn list_commit_ids(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Set<CommitId>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::list_commit_ids");
            self.list_ids(sedimentree_id, Kind::Commits).await
        })
    }

    fn load_loose_commits(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Vec<VerifiedMeta<LooseCommit>>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::load_loose_commits");
            self.load_items(sedimentree_id, Kind::Commits, None).await
        })
    }

    fn load_loose_commit_metas(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Vec<LooseCommit>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::load_loose_commit_metas");
            self.load_metas(sedimentree_id, Kind::Commits).await
        })
    }

    fn load_loose_commit(
        &self,
        sedimentree_id: SedimentreeId,
        commit_id: CommitId,
    ) -> Async::Future<'_, Result<Option<VerifiedMeta<LooseCommit>>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(
                ?sedimentree_id,
                ?commit_id,
                "ObjectStorage::load_loose_commit"
            );
            Ok(self
                .load_items(sedimentree_id, Kind::Commits, Some(commit_id))
                .await?
                .into_iter()
                .next())
        })
    }

    fn delete_loose_commit(
        &self,
        sedimentree_id: SedimentreeId,
        commit_id: CommitId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(
                ?sedimentree_id,
                ?commit_id,
                "ObjectStorage::delete_loose_commit"
            );
            self.delete_prefix(&self.item_dir(sedimentree_id, Kind::Commits, commit_id))
                .await
        })
    }

    fn delete_loose_commits(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::delete_loose_commits");
            self.delete_prefix(&self.kind_path(sedimentree_id, Kind::Commits))
                .await
        })
    }

    // ==================== Fragments (compound with blob) ====================

    fn save_fragment(
        &self,
        sedimentree_id: SedimentreeId,
        verified: VerifiedMeta<Fragment>,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::save_fragment");
            let pending = self.pending_fragment(sedimentree_id, verified);
            self.save(sedimentree_id, vec![pending]).await
        })
    }

    fn load_fragment(
        &self,
        sedimentree_id: SedimentreeId,
        fragment_head: CommitId,
    ) -> Async::Future<'_, Result<Option<VerifiedMeta<Fragment>>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(
                ?sedimentree_id,
                ?fragment_head,
                "ObjectStorage::load_fragment"
            );
            Ok(self
                .load_items(sedimentree_id, Kind::Fragments, Some(fragment_head))
                .await?
                .into_iter()
                .next())
        })
    }

    fn list_fragment_ids(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Set<CommitId>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::list_fragment_ids");
            self.list_ids(sedimentree_id, Kind::Fragments).await
        })
    }

    fn load_fragments(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Vec<VerifiedMeta<Fragment>>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::load_fragments");
            self.load_items(sedimentree_id, Kind::Fragments, None).await
        })
    }

    fn load_fragment_metas(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<Vec<Fragment>, Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::load_fragment_metas");
            self.load_metas(sedimentree_id, Kind::Fragments).await
        })
    }

    fn delete_fragment(
        &self,
        sedimentree_id: SedimentreeId,
        fragment_head: CommitId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(
                ?sedimentree_id,
                ?fragment_head,
                "ObjectStorage::delete_fragment"
            );
            self.delete_prefix(&self.item_dir(sedimentree_id, Kind::Fragments, fragment_head))
                .await
        })
    }

    fn delete_fragments(
        &self,
        sedimentree_id: SedimentreeId,
    ) -> Async::Future<'_, Result<(), Self::Error>> {
        Async::from_future(async move {
            tracing::trace!(?sedimentree_id, "ObjectStorage::delete_fragments");
            self.delete_prefix(&self.kind_path(sedimentree_id, Kind::Fragments))
                .await
        })
    }

    // ==================== Batch Operations ====================

    fn save_batch(
        &self,
        sedimentree_id: SedimentreeId,
        commits: Vec<VerifiedMeta<LooseCommit>>,
        fragments: Vec<VerifiedMeta<Fragment>>,
    ) -> Async::Future<'_, Result<usize, Self::Error>> {
        Async::from_future(async move {
            let num_commits = commits.len();
            let num_fragments = fragments.len();
            tracing::trace!(
                ?sedimentree_id,
                num_commits,
                num_fragments,
                "ObjectStorage::save_batch"
            );

            let pending = commits
                .into_iter()
                .map(|v| self.pending_commit(sedimentree_id, v))
                .chain(
                    fragments
                        .into_iter()
                        .map(|v| self.pending_fragment(sedimentree_id, v)),
                )
                .collect();
            self.save(sedimentree_id, pending).await?;

            Ok(num_commits + num_fragments)
        })
    }
}
