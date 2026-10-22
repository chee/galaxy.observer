# galaxy.observer

A [Subduction](https://github.com/inkandswitch/subduction) sync server with
keyhive, storing in a volume or an S3-compatible bucket, and an
[iroh](https://iroh.computer) relay at `https://galaxy.observer`. It syncs
over WebSocket, HTTP long-poll and iroh. `GET /` is the homepage in
`public/`. Beside it runs ermine's littlesync gateway, for littlesync devices,
at `/littlesync`.

## What's here

| | |
| --- | --- |
| `subduction_object_storage/` | A Rust crate: Subduction's `Storage` (and keyhive's `KeyhiveStorage`) over an object store. Standalone, builds against the published subduction crates. See its README. |
| `subduction.patch` | Changes to upstream's `subduction_cli` server and `subduction_core`, against the commit pinned in the `Dockerfile`. |
| `public/` | The homepage. |
| `littlesync/` | ermine's littlesync gateway, copied from an ermine checkout by `vendor.sh`; `build.sh` compiles it into one executable. |
| `migrate/` | One-off job that copied the old automerge-repo server's Postgres storage (starlight, now deleted) into this server, keeping document IDs. It patches upstream's ingest tool to wait until the server confirms each document. |
| `subduction.rev` | The upstream commit the patch is made against (upstream's latest as of 2026-09-30, `keyhive_core` 0.6, which talks to `automerge-repo-keyhive` 0.6 clients). |
| `.github/workflows/image.yml`, `Dockerfile.runtime` | On every push to `subduction`: build the server and the gateway once and publish `ghcr.io/chee/galaxy.observer`. Deploys pull that image. |
| `Dockerfile`, `start.sh` | The same build from source in one Dockerfile, and the start script both images run. |

The patch gives the server:

- `--object-store <URL>` (or `SUBDUCTION_OBJECT_STORE`): keep sedimentree and
  keyhive data in a bucket. Without it the server keeps files on local disk:
  upstream's `sedimentree_fs_storage`, one `.meta` and one `.blob` file for
  each commit and fragment, in place of upstream's redb database.
- `subduction_cli from-object-store --from <URL> --to <DIR>`: copy a bucket's
  documents and keyhive state into a data directory. The bucket is only read,
  and a second run copies only what is new.
- `GET /.well-known/keyhive/contact-card.json` (also `/contact-card.json` and
  `/contact-card`): the server's keyhive contact
  card.
- `--ws-pull-peer <URL>`: pull from another server without pushing to it.
  Before answering a client's request for a document, the server syncs it
  with the peer (at most 5 seconds; skipped once it is subscribed there), so
  a document only the peer holds is in the first answer. Nothing is synced
  in a sweep: on a reconnect only the documents clients have asked for are
  synced again, 8 at a time. The peer is refused every fetch and gets no document data or
  presence; keyhive ops flow both ways. It is greeted with the URL's host,
  less any trailing dot, as its service name.
- `--serve-iroh-relay`: be an iroh relay on the sync port. WebSocket
  upgrades to `/relay` go to an in-process `iroh-relay` server, and plain
  `GET /ping` and `/generate_204` answer iroh's probes, so an iroh endpoint
  can use `https://galaxy.observer` as its relay URL. Anyone may relay
  through it. There is no QUIC address discovery: that needs a UDP port,
  which Railway doesn't route.
- `GET /.well-known/iroh`: how to reach the server over iroh, e.g.
  `{"endpoint_id":"b73d…","relay_urls":["https://galaxy.observer/"],"alpn":"subduction/0","relay":true}`.
- `--iroh-pull-peer ENDPOINT_ID@SERVICE_NAME`: `--ws-pull-peer` over iroh,
  the same pull-only rules and pull-before-answering included.
- `--iroh` keeps the same endpoint ID across restarts: it's the server's key
  (as keyhive's identity is), so the endpoint ID is the peer ID. Upstream
  made a new one each start. `start.sh` turns iroh on with this server's own
  relay as its home, which is how iroh peers reach it, since Railway routes
  no inbound UDP.
- `--littlesync-gateway <ADDR>`: pass connections whose first request is for
  `/littlesync` or `/littlesync/...` through to the gateway at that address,
  as they are: WebSocket upgrades and plain HTTP (kept alive, long polls).
- `--static-dir <DIR>`: serve files to plain `GET` requests on the sync port.
  Each plain request gets its own connection, so a client's later WebSocket
  upgrade never lands on a page connection.
- A commit or fragment a client sends reaches the document's other
  subscribers before the server has saved it, so the save isn't added to
  every keystroke on its way between collaborators. The sender's ack still
  waits for the save, and while the save runs the server counts the item as
  held, so a sync in that window doesn't ask for it again. (In
  `subduction_core`: upstream saved, then forwarded, and asked again.)

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SERVICE_NAME` | `galaxy.observer` | must equal the host in the client's URL |
| `SUBDUCTION_AUTH` | `keyhive` | `open` turns keyhive off |
| `SUBDUCTION_OBJECT_STORE` | unset | `s3://bucket/prefix`; unset stores on the `/data` volume |
| `SUBDUCTION_COPY_FROM` | unset | `s3://bucket/prefix`: copy that bucket into `/data/store` at startup, before the server starts (see below) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL` | | bucket credentials and endpoint |
| `SUBDUCTION_PULL_PEERS` | unset | space-separated `wss://` URLs to pull from but never push to, e.g. `wss://subduction.sync.inkandswitch.com` |
| `SUBDUCTION_IROH_PULL_PEERS` | unset | space-separated `ENDPOINT_ID@SERVICE_NAME` iroh peers to pull from but never push to |
| `SUBDUCTION_KEY_SEED` | unset | 64 hex characters; unset generates a key at `/data/key` |
| `GATEWAY_SEED` | unset | 64 hex characters: the littlesync gateway's key (its peer ID); unset generates one at `/data/littlesync-key` |
| `LITTLESYNC_PORT` | `8081` | the gateway's own port, inside the container |
| `QUIET` | unset | `1`: the gateway logs only its upstream lines, not one per message |
| `PORT` | `8080` | |

With a bucket, `SUBDUCTION_KEY_SEED` and `GATEWAY_SEED` the server needs no volume.

### Moving from the bucket to the volume

1. Mount a volume at `/data`.
2. Set `SUBDUCTION_COPY_FROM` to the value `SUBDUCTION_OBJECT_STORE` has,
   unset `SUBDUCTION_OBJECT_STORE`, and deploy. The container copies the
   bucket into `/data/store` (the old deployment has stopped by then, so the
   copy has everything), then starts the server on it. The server is down
   while the copy runs.
3. Unset `SUBDUCTION_COPY_FROM`. Leave the bucket alone until you're sure:
   setting `SUBDUCTION_OBJECT_STORE` again goes back to it, without what was
   written since.

## The littlesync gateway

`littlesync/` holds the gateway (`playground/together/stacks/littlesync/gateway/main.ts`
in ermine, where its README says what it does) and every ermine file it
imports, at the same paths; `VENDORED` says which ermine commit. `start.sh`
runs it beside the server as a Subduction client of `ws://127.0.0.1:$PORT`,
and the container stops when either one does. Copy it again from a checkout of
ermine beside this one:

```sh
sh littlesync/vendor.sh ../ermine
sh littlesync/build.sh /tmp/littlesync-gateway   # the executable the image gets
```

The image workflow compiles it with Deno; the npm packages it uses
(`@automerge/subduction`, `@noble/hashes`) are pinned in `littlesync/deno.lock`
and fetched then.

## tippet

The tippet galaxy (`experiments/tippet/galaxy.ts` in ermine) runs in the
gateway's process, behind `littlesync/front.ts`. The front takes what the
server passes for `/littlesync` and answers `/littlesync/tippet/<room>` itself:
a websocket there, or HTTP long-poll at `.../send` and `.../recv`. It hands
everything else to the gateway, which now listens on `GATEWAY_PORT` (default
8082). Each room's log is kept under `$DATA_DIR/tippet`. Copy it again with:

```sh
sh littlesync/vendor-tippet.sh ../ermine   # after vendor.sh, if both
```

`VENDORED-tippet` records which ermine commit it came from.

## Working on the server patch

```sh
git clone https://github.com/inkandswitch/subduction && cd subduction
git checkout "$(cat /path/to/galaxy.observer/subduction.rev)"
ln -s /path/to/galaxy.observer/subduction_object_storage .
git apply /path/to/galaxy.observer/subduction.patch
cargo test -p subduction_cli -p subduction_core -p subduction_object_storage
```

Regenerate the patch from that checkout:

```sh
git add -N subduction_cli subduction_core
git diff HEAD --binary -- Cargo.toml Cargo.lock subduction_cli subduction_core > /path/to/galaxy.observer/subduction.patch
```

The crate tests on its own with `cargo test --all-features` in
`subduction_object_storage/`.

The old automerge-repo server is on the `railway` branch.
