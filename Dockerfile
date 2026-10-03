# galaxy.observer: a Subduction sync server (github.com/inkandswitch/subduction)
# built with this repo's object storage backend and server patch.
#
# This builds everything from source. Deploys use the image the `image`
# workflow publishes instead (see Dockerfile.runtime).
FROM rust:1.91-slim-bookworm AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev cmake clang \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
# subduction.rev pins the upstream commit subduction.patch is made against
COPY subduction.rev /tmp/subduction.rev
RUN git init -q . \
	&& git remote add origin https://github.com/inkandswitch/subduction \
	&& git fetch -q --depth 1 origin "$(cat /tmp/subduction.rev)" \
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
