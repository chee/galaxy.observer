#!/bin/sh
set -eu

# /data is the persistent volume. The key seed is the server's identity (its
# subduction peer id and its keyhive identity), so it lives there too.
DATA_DIR="${DATA_DIR:-/data}"
KEY_FILE="$DATA_DIR/key"
mkdir -p "$DATA_DIR/store"
if [ ! -s "$KEY_FILE" ]; then
	(umask 077 && head -c 32 /dev/urandom > "$KEY_FILE")
fi

# SERVICE_NAME must equal the host clients put in their URL or the handshake fails.
exec subduction_cli server \
	--socket "0.0.0.0:${PORT:-8080}" \
	--data-dir "$DATA_DIR/store" \
	--key-file "$KEY_FILE" \
	--service-name "${SERVICE_NAME:-galaxy.observer}" \
	--auth "${SUBDUCTION_AUTH:-keyhive}"
