# ── Build stage ───────────────────────────────────────────────────────────────
# Compiles the axum server to a single static-ish binary. sqlx uses runtime
# queries (no compile-time `query!` macros) so NO database is needed at build
# time; migrations are embedded into the binary via `sqlx::migrate!`.
FROM rust:1-bookworm AS builder
WORKDIR /build

# 1) Cache dependency compilation: copy manifests, build a dummy crate so the
#    (slow) dependency layer is reused whenever only our own source changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 2) Build the real binary. `migrations/` must be present — sqlx::migrate!
#    embeds it at compile time.
COPY src ./src
COPY migrations ./migrations
RUN touch src/main.rs && cargo build --release

# ── Discrawl stage ────────────────────────────────────────────────────────────
# Managed Discord clone uses discrawl to mirror a Discord server into SQLite, then
# the Ohiyo importer maps that SQLite archive into a new Ohiyo space.
FROM golang:1.26-bookworm AS discrawl-builder
WORKDIR /discrawl
RUN git clone --depth 1 https://github.com/steipete/discrawl.git . \
    && go build -o /usr/local/bin/discrawl ./cmd/discrawl

# ── Runtime stage ─────────────────────────────────────────────────────────────
# reqwest uses rustls (no OpenSSL) and sqlx bundles SQLite, so the runtime image
# only needs CA certificates. WORKDIR is the volume mount point: both the SQLite
# DB and the relative `uploads/` directory live here so they persist.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Litestream — continuous SQLite replication for point-in-time backups. Installed
# unconditionally but a complete no-op unless LITESTREAM_REPLICA_URL is set (the
# entrypoint passes straight through to the server otherwise). TARGETARCH lets
# Apple Silicon local builds use arm64 while Fly's runtime continues using amd64.
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.3.13
ADD https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

WORKDIR /data
COPY --from=builder /build/target/release/server /usr/local/bin/ohiyo-server
COPY --from=discrawl-builder /usr/local/bin/discrawl /usr/local/bin/discrawl
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

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
