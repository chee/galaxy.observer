# galaxy.observer

A [Subduction](https://github.com/inkandswitch/subduction) sync server with
keyhive, storing in a volume or an S3-compatible bucket. `GET /` is the
homepage in `public/`.

## What's here

| | |
| --- | --- |
| `subduction_object_storage/` | A Rust crate: Subduction's `Storage` (and keyhive's `KeyhiveStorage`) over an object store. Standalone, builds against the published subduction crates. See its README. |
| `subduction.patch` | Changes to upstream's `subduction_cli` server, against the commit pinned in the `Dockerfile`. |
| `public/` | The homepage. |
| `migrate/` | One-off job that copied the old automerge-repo server's Postgres storage (starlight, now deleted) into this server, keeping document IDs. It patches upstream's ingest tool to wait until the server confirms each document. |
| `subduction.rev` | The upstream commit the patch is made against (upstream's latest as of 2026-09-30, `keyhive_core` 0.6, which talks to `automerge-repo-keyhive` 0.6 clients). |
| `.github/workflows/image.yml`, `Dockerfile.runtime` | On every push to `subduction`: build the server once and publish `ghcr.io/chee/galaxy.observer`. Deploys pull that image. |
| `Dockerfile`, `start.sh` | The same build from source in one Dockerfile, and the start script both images run. |

The patch gives the server:

- `--object-store <URL>` (or `SUBDUCTION_OBJECT_STORE`): keep sedimentree and
  keyhive data in a bucket. Without it the server uses redb on local disk.
- `GET /.well-known/keyhive/contact-card.json` (also `/contact-card.json` and
  `/contact-card`): the server's keyhive contact
  card.
- `--static-dir <DIR>`: serve files to plain `GET` requests on the sync port.
  Each plain request gets its own connection, so a client's later WebSocket
  upgrade never lands on a page connection.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SERVICE_NAME` | `galaxy.observer` | must equal the host in the client's URL |
| `SUBDUCTION_AUTH` | `keyhive` | `open` turns keyhive off |
| `SUBDUCTION_OBJECT_STORE` | unset | `s3://bucket/prefix`; unset stores on the `/data` volume |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL` | | bucket credentials and endpoint |
| `SUBDUCTION_KEY_SEED` | unset | 64 hex characters; unset generates a key at `/data/key` |
| `PORT` | `8080` | |

With a bucket and `SUBDUCTION_KEY_SEED` the server needs no volume.

## Working on the server patch

```sh
git clone https://github.com/inkandswitch/subduction && cd subduction
git checkout "$(cat /path/to/galaxy.observer/subduction.rev)"
ln -s /path/to/galaxy.observer/subduction_object_storage .
git apply /path/to/galaxy.observer/subduction.patch
cargo test -p subduction_cli -p subduction_object_storage
```

Regenerate the patch from that checkout:

```sh
git add -N subduction_cli
git diff HEAD --binary -- Cargo.toml Cargo.lock subduction_cli > /path/to/galaxy.observer/subduction.patch
```

The crate tests on its own with `cargo test --all-features` in
`subduction_object_storage/`.

The old automerge-repo server is on the `railway` branch.
