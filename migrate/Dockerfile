# One-off job: move starlight (the old automerge-repo Postgres) into the
# Subduction server. See migrate.mjs.
FROM rust:1.91-slim-bookworm AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev cmake clang \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG SUBDUCTION_REV=472c50886b20d9fdaaaf963ca16822877869d48b
RUN git init -q . \
	&& git remote add origin https://github.com/inkandswitch/subduction \
	&& git fetch -q --depth 1 origin "$SUBDUCTION_REV" \
	&& git checkout -q FETCH_HEAD
# Don't exit until the server confirms it holds the whole document; see the patch.
COPY ingest-confirm.patch /tmp/ingest-confirm.patch
RUN git apply /tmp/ingest-confirm.patch
RUN cargo build --release --locked -p automerge_subduction_ingest

FROM node:22-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates libssl3 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/automerge-subduction-ingest /usr/local/bin/
WORKDIR /app
COPY package.json migrate.mjs ./
RUN npm install --omit=dev --no-audit --no-fund
CMD ["node", "migrate.mjs"]
