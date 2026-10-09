# `subduction_slatedb_storage`

A [SlateDB] backend for Sedimentree, implementing the `Storage` trait from
`subduction_core`. SlateDB is an LSM tree kept entirely in an object store:
Amazon S3 and S3-compatible services (R2, Tigris, MinIO), a local directory,
or memory. The server keeps nothing on local disk.

```rust,ignore
let storage = SlateDbStorage::from_url(&"s3://my-bucket/sync".parse()?).await?;
// …
storage.close().await?;
```

`s3://` URLs take credentials and endpoint from the `AWS_*` environment
variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`AWS_ENDPOINT_URL`). For a service that wants virtual-hosted requests, set
`AWS_VIRTUAL_HOSTED_STYLE_REQUEST=true` and give its base endpoint; the bucket
is put in front of the host.

## Layout

One sorted keyspace, laid out as `subduction_redb_storage` lays out its
tables:

```text
t ++ tree_id                           → ()                   registered trees
c ++ tree_id ++ commit_id ++ digest    → Signed<LooseCommit>  bytes
C ++ tree_id ++ commit_id ++ digest    → blob
f ++ tree_id ++ head_id ++ digest      → Signed<Fragment>     bytes
F ++ tree_id ++ head_id ++ digest      → blob
k ++ namespace ++ / ++ a|e ++ hash     → keyhive archive | event
```

A tree's items are contiguous, so loading it is a range scan. Metadata and
blobs are separate keys, so metadata-only hydration never reads blobs.

## Writes

Every save is one atomic write batch: an item's metadata, its blob and the
tree's registration land together or not at all, and `save_batch` is atomic.
A save returns once it is durable in the object store. SlateDB gathers the
writes of every tree into one write-ahead log object per flush interval
(100ms), so `PUT`s follow time, not traffic. The flip side is that a save
takes up to the flush interval longer.

`with_durable_saves(false)` returns from a save once it is in memory, where
every read already sees it, so the server forwards it to subscribers at once
(2ms a save in the comparison below, against 102ms durable). A crash then
loses the last flush interval's saves from the server; peers that still hold
them send them again on their next sync, since the server asks for what it
lacks. `close` uploads them on a clean shutdown. Keyhive state is always
saved durably.

## One writer

A database has one writer. Opening it fences out the previous writer, whose
later writes fail: a new deploy takes over from the old one that way. Servers
that run side by side need their own prefixes.

Call `close` on shutdown. A writer that stops without closing leaves its log
for the next open to replay (up to 4096 objects, fetched in parallel).

## Keyhive

With the `keyhive` feature, `storage.keyhive()` is a `KeyhiveStorage` in the
same database; `storage.keyhive_in(namespace)` keeps keyhive versions that
can't read each other's events apart.

## Cost

Against `subduction_object_storage`, on an in-memory store adding 25ms to
every request: 200 documents of 10 commits and a fragment each, then 50
clients saving 20 commits each, then a restart and every document hydrated
and served.

| | object storage | SlateDB |
| --- | --- | --- |
| ingest 200 documents | 2450 `PUT`, 0.8s | 13 `PUT`, 1.3s |
| 1000 live saves | 1000 `PUT`, 27ms a save | 20 `PUT`, 102ms a save |
| idle | nothing | ~1 `GET` a second |
| hydrate all (metadata) | 3200 `GET` + 401 `LIST` | 244 `GET` |
| serve all (with blobs) | 3250 `GET` + 400 `LIST` | 406 `GET` |

Scans read 64 KiB at a time and cache what they read; SlateDB's defaults read
one block per request and cache nothing. The database polls for a newer
writer and for compactions every 10 seconds rather than every second.

[SlateDB]: https://slatedb.io
