#!/bin/sh
set -eu

# The key seed is the server's identity: its subduction peer id and its
# keyhive identity. SUBDUCTION_KEY_SEED (64 hex characters) sets it; without
# one it is generated once and kept on the /data volume.
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/store"
if [ -n "${SUBDUCTION_KEY_SEED:-}" ]; then
	set -- --key-seed "$SUBDUCTION_KEY_SEED"
else
	KEY_FILE="$DATA_DIR/key"
	if [ ! -s "$KEY_FILE" ]; then
		(umask 077 && head -c 32 /dev/urandom > "$KEY_FILE")
	fi
	set -- --key-file "$KEY_FILE"
fi

# SUBDUCTION_PULL_PEERS: space-separated WebSocket URLs of servers to pull
# documents from without ever sending them any.
for url in ${SUBDUCTION_PULL_PEERS:-}; do
	set -- "$@" --ws-pull-peer "$url"
done

# SUBDUCTION_IROH_PULL_PEERS: the same over iroh, as space-separated
# ENDPOINT_ID@SERVICE_NAME.
for peer in ${SUBDUCTION_IROH_PULL_PEERS:-}; do
	set -- "$@" --iroh-pull-peer "$peer"
done

# Storage is redb under $DATA_DIR/store unless SUBDUCTION_OBJECT_STORE names a
# bucket (s3://bucket/prefix, with AWS_* credentials), which the server reads
# from the environment itself.
#
# SERVICE_NAME must equal the host clients put in their URL or the handshake fails.
#
# --serve-iroh-relay makes the same port an iroh relay: iroh endpoints use
# https://$SERVICE_NAME as their relay URL. --iroh also syncs over iroh, with
# that relay as home: Railway routes no inbound UDP, so peers reach the
# server through it. Its endpoint ID is its peer ID.
exec subduction_cli server \
	--socket "0.0.0.0:${PORT:-8080}" \
	--data-dir "$DATA_DIR/store" \
	--service-name "${SERVICE_NAME:-galaxy.observer}" \
	--auth "${SUBDUCTION_AUTH:-keyhive}" \
	--static-dir /srv/public \
	--serve-iroh-relay \
	--iroh \
	--iroh-relay-url "https://${SERVICE_NAME:-galaxy.observer}" \
	"$@"
