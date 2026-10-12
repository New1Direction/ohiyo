# Litestream — continuous SQLite backup

The Ohiyo runtime image (`server/Dockerfile`) bundles
[Litestream](https://litestream.io) 0.3.13 and runs it via `server/docker-entrypoint.sh`.
It is **opt-in and a no-op unless `LITESTREAM_REPLICA_URL` is set** — the entrypoint
otherwise execs the server unchanged.

When enabled, Litestream:

- **streams** the SQLite WAL to object storage (synced every 10 seconds), with a fresh
  snapshot every day and 3 days of history, and
- **restores** the database from the replica on boot when the volume has no database
  (e.g. a new volume after losing the old one).

It covers the database only. Uploaded files live in `OHIYO_UPLOAD_DIR` on the volume and
are not copied.

## Enable it on Railway with Cloudflare R2 (the hosted service)

1. In Cloudflare: **R2 → Create bucket** (e.g. `ohiyo-backups`), then **R2 → Manage API
   tokens → Create API token** with *Object Read & Write* on that bucket only. Note the
   access key ID, the secret access key and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).

2. Set four variables on the server service (Railway → service → Variables). They are
   credentials: keep them out of the repo and out of chat.

   | Variable | Value |
   |---|---|
   | `LITESTREAM_REPLICA_URL` | `s3://ohiyo-backups/ohiyo.db` |
   | `LITESTREAM_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `LITESTREAM_ACCESS_KEY_ID` | the token's access key ID |
   | `LITESTREAM_SECRET_ACCESS_KEY` | the token's secret access key |

   `LITESTREAM_REGION` is optional (default `auto`, which R2 wants; Backblaze B2 needs
   its own, e.g. `us-west-004`). `DATABASE_URL` already points at `/data/ohiyo.db`; the
   entrypoint derives the file path from it.

   Why the endpoint is its own variable: Litestream 0.3 takes an S3 endpoint only from a
   config file. It ignores `?endpoint=` in a replica URL and talks to AWS. With
   `LITESTREAM_ENDPOINT` set, the entrypoint writes that config file
   (`server/litestream-config.sh`) to the temp directory; the keys are not in it, since
   Litestream reads them from the environment.

3. Deploy. The logs should show:

   ```
   litestream: /data/ohiyo.db -> s3://ohiyo-backups/ohiyo.db at https://<account-id>.r2.cloudflarestorage.com
   ... msg="replicating to" name=s3 type=s3 sync-interval=10s bucket=ohiyo-backups path=ohiyo.db region=auto endpoint=https://...
   ```

   and no `monitor error` after it. In the bucket, `ohiyo.db/generations/<id>/` fills
   with `snapshots/` and `wal/`.

AWS S3 needs no endpoint: set `LITESTREAM_REPLICA_URL=s3://bucket/ohiyo.db` and the two
keys, and the entrypoint passes the URL to Litestream as before.

## What happens at boot

- **A database is on the volume** (every normal deploy): nothing is restored and the
  store is not asked, so a store that can't be reached never keeps the server down.
  Litestream logs `monitor error` until the store answers again.
- **No database on the volume, backups in the store:** the newest backup is restored,
  then the server starts.
- **No database, empty store** (the very first deploy): the server starts empty.
- **No database, and the store can't be read:** the server does not start. Starting
  empty would hide the loss, and the empty database would start replacing the backup.

## Verify a restore (do this before you trust it)

From a machine with Litestream 0.3.13 and the same four variables in the environment,
restore into a temp file and check it, without touching the live database:

```bash
LITESTREAM_REPLICA_URL=s3://ohiyo-backups/ohiyo.db \
LITESTREAM_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=... \
  scripts/backup-restore-drill.sh
```

It prints `integrity_check=ok` and the row counts of the core tables.

## Notes

- The image installs the Litestream `.deb` for the build's architecture (`TARGETARCH`).
- Litestream needs exactly **one** writer — fine here, since the app runs as a single
  instance (SQLite on a local volume). Do not run two replicas of the server.
- A sync every 10 seconds keeps the store's write count low (R2 counts each upload) at
  the cost of up to 10 seconds of messages if the volume is lost.
