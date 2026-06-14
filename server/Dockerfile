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

# ── Runtime stage ─────────────────────────────────────────────────────────────
# reqwest uses rustls (no OpenSSL) and sqlx bundles SQLite, so the runtime image
# only needs CA certificates. WORKDIR is the volume mount point: both the SQLite
# DB and the relative `uploads/` directory live here so they persist.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /data
COPY --from=builder /build/target/release/server /usr/local/bin/kikkacord-server

ENV BIND_ADDR=0.0.0.0:3000 \
    DATABASE_URL=sqlite:/data/kikkacord.db \
    RUST_LOG=server=info,tower_http=warn

EXPOSE 3000
CMD ["kikkacord-server"]
