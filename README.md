# galaxy.observer

A [Subduction](https://github.com/inkandswitch/subduction) sync server, with keyhive.

The Dockerfile builds `subduction_cli` at a pinned commit. Storage is the
server's own redb + blob-file store on a volume mounted at `/data`; the server
key is generated there on first boot.

| Variable | Default | |
| --- | --- | --- |
| `SERVICE_NAME` | `galaxy.observer` | must equal the host in the client's URL |
| `SUBDUCTION_AUTH` | `keyhive` | `open` turns keyhive off |
| `PORT` | `8080` | |

The old automerge-repo server is on the `railway` branch.
