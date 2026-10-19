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

# The littlesync gateway (littlesync/): a Subduction client of this server for
# littlesync devices, on a port of its own. The server passes /littlesync and
# /littlesync/* on its port through to it. GATEWAY_SEED (64 hex characters) is
# its key, kept the same across restarts as the server's is: without one it is
# generated once and kept on the /data volume.
SERVER_PORT="${PORT:-8080}"
LITTLESYNC_PORT="${LITTLESYNC_PORT:-8081}"
if [ -z "${GATEWAY_SEED:-}" ]; then
	GATEWAY_SEED_FILE="$DATA_DIR/littlesync-key"
	if [ ! -s "$GATEWAY_SEED_FILE" ]; then
		(umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$GATEWAY_SEED_FILE")
	fi
	GATEWAY_SEED=$(cat "$GATEWAY_SEED_FILE")
fi

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
subduction_cli server \
	--socket "0.0.0.0:$SERVER_PORT" \
	--data-dir "$DATA_DIR/store" \
	--service-name "${SERVICE_NAME:-galaxy.observer}" \
	--auth "${SUBDUCTION_AUTH:-keyhive}" \
	--static-dir /srv/public \
	--serve-iroh-relay \
	--iroh \
	--iroh-relay-url "https://${SERVICE_NAME:-galaxy.observer}" \
	--littlesync-gateway "127.0.0.1:$LITTLESYNC_PORT" \
	"$@" &
server=$!

PORT="$LITTLESYNC_PORT" \
	UPSTREAM="ws://127.0.0.1:$SERVER_PORT" \
	UPSTREAM_SERVICE="${SERVICE_NAME:-galaxy.observer}" \
	GATEWAY_SEED="$GATEWAY_SEED" \
	littlesync-gateway &
gateway=$!

# A stop (Railway's SIGTERM) goes to both, and waits for the server to finish.
trap 'kill -TERM "$server" "$gateway" 2>/dev/null || true; wait; exit 0' TERM INT

# Either one ending ends the container, with a failure, so Railway restarts it.
while kill -0 "$server" 2>/dev/null && kill -0 "$gateway" 2>/dev/null; do
	sleep 1
	jobs >/dev/null # reaps an exited child, so kill -0 stops finding it
done
if kill -0 "$server" 2>/dev/null; then
	echo "start.sh: the littlesync gateway exited; stopping the server" >&2
else
	echo "start.sh: the server exited; stopping the littlesync gateway" >&2
fi
kill -TERM "$server" "$gateway" 2>/dev/null || true
wait
exit 1
