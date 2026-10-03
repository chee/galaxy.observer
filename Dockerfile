# galaxy.observer: a Subduction sync server (github.com/inkandswitch/subduction)
# built with this repo's object storage backend and server patch.
FROM rust:1.91-slim-bookworm AS build
# v0.18.0-nightly.2026-09-30; subduction.patch is made against this commit
ARG SUBDUCTION_REV=2566cbfc5d1d529ed8c109009a645ee73d7dc0dd
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev cmake clang \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . \
	&& git remote add origin https://github.com/inkandswitch/subduction \
	&& git fetch -q --depth 1 origin "$SUBDUCTION_REV" \
	&& git checkout -q FETCH_HEAD
COPY subduction_object_storage ./subduction_object_storage
COPY subduction.patch /tmp/subduction.patch
RUN git apply /tmp/subduction.patch
RUN cargo build --release --locked -p subduction_cli

FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates libssl3 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/subduction_cli /usr/local/bin/subduction_cli
COPY public /srv/public
COPY start.sh /usr/local/bin/start.sh
CMD ["/usr/local/bin/start.sh"]
