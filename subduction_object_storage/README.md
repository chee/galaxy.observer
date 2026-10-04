# `subduction_object_storage`

An object storage backend for Sedimentree, implementing the `Storage` trait
from `subduction_core` on top of the [`object_store`] crate: Amazon S3 and
S3-compatible services (R2, Tigris, MinIO), a local directory, or memory.

Everything lives in the bucket, so a server using this backend keeps no
sedimentree state on local disk and several servers can share one bucket.

```rust,ignore
let storage = ObjectStorage::from_url(&"s3://my-bucket/sync".parse()?)?;
```

`s3://` URLs take credentials and endpoint from the `AWS_*` environment
variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`AWS_ENDPOINT_URL`). For a service that wants virtual-hosted requests, set
`AWS_VIRTUAL_HOSTED_STYLE_REQUEST=true` and give its base endpoint; the bucket
is put in front of the host.

## Layout

```text
{prefix}/
├── ids/
│   └── {tree_hex}                       ← registration marker (empty)
└── trees/
    └── {tree_hex}/
        ├── commits/
        │   └── {commit_id_hex}/
        │       ├── {digest_hex}         ← signed metadata (+ blob when small)
        │       └── {digest_hex}.blob    ← blob, when > inline threshold
        └── fragments/
            └── {head_id_hex}/
                ├── {digest_hex}
                └── {digest_hex}.blob
```

Blobs up to `DEFAULT_INLINE_THRESHOLD` (16 KiB) ride inline with their
metadata, so a save is one `PUT` and a load is one `GET`. Larger blobs are
separate objects, which metadata-only hydration never downloads.

## Keyhive

With the `keyhive` feature, `storage.keyhive()` is a `KeyhiveStorage` in the
same bucket under `{prefix}/keyhive/`; `storage.keyhive_in(dir)` puts it under
`{prefix}/{dir}/` instead, for keyhive versions that can't read each other's
events. Events are content-addressed, so servers
sharing a bucket add to one set. An archive is keyed by its owner's identity,
so servers that share a key overwrite each other's snapshot; give servers that
run side by side their own keys.

## Consistency

Object stores have no transactions, so ordering stands in for them: a large
blob is written before the item that references it, and the tree's
registration marker is written last. A failed save never registers a tree,
and a crash leaves at most an unreferenced object that the next save of the
same content completes. `save_batch` is not atomic.

## Cost

A save is one `PUT` (two with a large blob), plus one for the tree's
registration marker the first time a process saves to that tree. Hydrating a
tree costs one `LIST` per 1000 objects plus one `GET` per item. Deployments with very
many loose commits per tree pay for that in requests; fragments keep the
count down.

[`object_store`]: https://docs.rs/object_store
