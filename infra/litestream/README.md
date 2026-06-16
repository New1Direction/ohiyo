# Litestream — continuous SQLite backup

The Ohiyo runtime image (`server/Dockerfile`) bundles
[Litestream](https://litestream.io) and runs it via `server/docker-entrypoint.sh`.
It is **opt-in and a no-op unless `LITESTREAM_REPLICA_URL` is set** — the entrypoint
otherwise execs the server unchanged.

When enabled, Litestream:

- **streams** the SQLite WAL to object storage continuously (seconds of RPO, vs the
  ~24h a daily Fly volume snapshot can lose), and
- **restores** the database from the replica on boot if the volume is empty (e.g. a
  fresh machine after volume loss) — `restore -if-db-not-exists`.

It protects against volume loss and human error; it is **not** a substitute for Fly's
volume snapshots (keep both — see `DEPLOY.md`).

## Enable it (Fly.io)

1. Create a bucket on any S3-compatible store — AWS S3, Cloudflare R2, Tigris (Fly's
   built-in: `fly storage create`), Backblaze B2, MinIO, etc.

2. Set the replica URL + credentials as Fly **secrets** (not `fly.toml` — they're
   credentials):

   ```bash
   cd server
   fly secrets set \
     LITESTREAM_REPLICA_URL="s3://your-bucket/ohiyo.db" \
     LITESTREAM_ACCESS_KEY_ID="<access-key>" \
     LITESTREAM_SECRET_ACCESS_KEY="<secret-key>"

   # Non-AWS endpoints (R2/Tigris/B2/MinIO) also need the endpoint:
   fly secrets set LITESTREAM_REPLICA_URL="s3://your-bucket/ohiyo.db?endpoint=https://<account>.r2.cloudflarestorage.com&region=auto"
   ```

   `DATABASE_URL` already points at `/data/ohiyo.db`; the entrypoint derives the
   file path from it.

3. `fly deploy`. Confirm in the logs:

   ```
   litestream: /data/ohiyo.db -> s3://your-bucket/ohiyo.db
   ```

## Verify a restore (do this before you trust it)

```bash
# From a machine with the same LITESTREAM_* env, into a scratch file:
litestream restore -o /tmp/restored.db "s3://your-bucket/ohiyo.db"
sqlite3 /tmp/restored.db "SELECT count(*) FROM users;"
```

## Notes

- The bundled binary is the Linux **amd64** `.deb` (Fly's runtime arch). Building the
  image for arm64 would need the arm64 asset.
- Litestream needs exactly **one** writer — fine here, since the app already runs as a
  single machine (SQLite on a local volume). Do not `fly scale count 2`.
