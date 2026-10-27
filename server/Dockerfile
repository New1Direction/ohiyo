# ── Build stage ───────────────────────────────────────────────────────────────
# Compiles the axum server to a single static-ish binary. sqlx uses runtime
# queries (no compile-time `query!` macros) so NO database is needed at build
# time; migrations are embedded into the binary via `sqlx::migrate!`.
# Build from the repository root: docker build -f server/Dockerfile .
FROM rust:1-bookworm AS builder
WORKDIR /build/server

# 1) Cache dependency compilation: copy manifests, build a dummy crate so the
#    (slow) dependency layer is reused whenever only our own source changes.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 2) Build the real binary. `migrations/` must be present — sqlx::migrate!
#    embeds it at compile time. Burrow embeds the trusted skills too, preserving
#    their repository-relative paths for include_str!.
COPY server/src ./src
COPY server/migrations ./migrations
COPY .agents/skills /build/.agents/skills
RUN touch src/main.rs && cargo build --release

# ── Discrawl stage ────────────────────────────────────────────────────────────
# Managed Discord clone uses discrawl to mirror a Discord server into SQLite, then
# the Ohiyo importer maps that SQLite archive into a new Ohiyo space.
# Pinned to a release tag and its commit: an unpinned clone of HEAD broke this build when
# upstream raised its Go requirement, and it pulled unreviewed third-party code into the
# image. To update, change the tag and the commit together.
FROM golang:1.27-bookworm AS discrawl-builder
ARG DISCRAWL_VERSION=v0.15.6
ARG DISCRAWL_COMMIT=cd7fa1ce5eb762891b84a334e8eecff2f3e67600
WORKDIR /discrawl
RUN git clone --depth 1 --branch "${DISCRAWL_VERSION}" https://github.com/steipete/discrawl.git . \
    && test "$(git rev-parse HEAD)" = "${DISCRAWL_COMMIT}" \
    && go build -o /usr/local/bin/discrawl ./cmd/discrawl

# Locked Pi dependencies: lifecycle scripts must never execute during packaging.
FROM node:26-bookworm-slim AS worker-builder
WORKDIR /opt/ohiyo-worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY worker/src ./src
COPY worker/config/practice-routing.json worker/config/practice-worker.json ./config/

# ── Runtime stage ─────────────────────────────────────────────────────────────
# reqwest uses rustls (no OpenSSL) and sqlx bundles SQLite, so the runtime image
# needs no system OpenSSL. Node and tini support the opt-in worker. WORKDIR is
# the volume mount point: the DB and relative `uploads/` directory persist here.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 tini \
    && rm -rf /var/lib/apt/lists/*

# Litestream — continuous SQLite replication for point-in-time backups. Installed
# unconditionally but a complete no-op unless LITESTREAM_REPLICA_URL is set (the
# entrypoint passes straight through to the server otherwise). TARGETARCH lets
# Apple Silicon local builds use arm64 while the hosted runtime uses amd64.
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.3.13
ADD https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

WORKDIR /data
COPY --from=builder /build/server/target/release/server /usr/local/bin/ohiyo-server
COPY --from=discrawl-builder /usr/local/bin/discrawl /usr/local/bin/discrawl
COPY --from=worker-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=worker-builder /opt/ohiyo-worker /opt/ohiyo-worker
COPY server/docker-entrypoint.sh server/litestream-config.sh /usr/local/bin/
COPY server/worker-supervisor.mjs /usr/local/bin/worker-supervisor.mjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/litestream-config.sh
# Execute in the final Debian image: builder-stage success does not prove Node's
# shared libraries or the installed Pi imports are available at runtime.
# Imports alone do not start a worker, open a service port or perform inference.
RUN node --version \
    && node --input-type=module -e "await import('/opt/ohiyo-worker/src/server.mjs'); await import('/usr/local/bin/worker-supervisor.mjs'); const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close();"

# Run as a dedicated non-root user. /data (the volume mount, holding the SQLite DB,
# litestream state and uploads/) must be writable by it; the bound port :3000 is
# unprivileged (>1024), so dropping root needs no extra capability.
RUN useradd -r -u 10001 -m ohiyo \
    && mkdir -p /data \
    && chown -R ohiyo /data
USER ohiyo

ENV BIND_ADDR=0.0.0.0:3000 \
    DATABASE_URL=sqlite:/data/ohiyo.db \
    OHIYO_DISCRAWL_BIN=/usr/local/bin/discrawl \
    RUST_LOG=server=info,tower_http=warn

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
