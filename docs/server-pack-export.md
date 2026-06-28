# Server Pack export

Ohiyo Server Pack export is the raw ownership handoff for a single hosted/self-hosted home.

## What it exports

`GET /api/v1/server-pack/export` returns `ohiyo-server-pack-<timestamp>.tar.gz` containing:

- `ohiyo.db` — a consistent SQLite snapshot made with `VACUUM main INTO`.
- `uploads/**` — uploaded blobs/files from the configured upload directory.
- `server-pack-manifest.json` — software/schema metadata, file sizes, and SHA-256 checksums.
- `server-pack-manifest.hmac-sha256` — HMAC-SHA256 over the manifest.

## Privacy boundary

The pack restores **infrastructure + ciphertext**. It does not make everyone’s readable history available to the exporting admin. Readable E2E history still depends on each user’s own device keys or personal recovery backup.

The pack may contain server metadata, ciphertext messages, encrypted/key-backup rows, and uploaded blobs. Do not describe it as an anonymous or plaintext-free artifact; describe it as an encrypted/ciphertext ownership export.

## Enablement and authorization

The endpoint is disabled unless:

```bash
OHIYO_SERVER_PACK_EXPORT=1
```

The caller must be authenticated and must own every server in that home. This keeps the endpoint suitable for dedicated Instant Servers/self-hosted homes and prevents a normal multi-tenant control-plane user from exporting other communities.

Provisioned Fly Instant Servers now receive `OHIYO_SERVER_PACK_EXPORT=1` automatically.

Optional manifest signing override:

```bash
OHIYO_EXPORT_SIGNING_SECRET=<strong secret>
```

If unset, the current `JWT_SECRET` signs the manifest.

Optional upload root override:

```bash
OHIYO_UPLOAD_DIR=/data/uploads
```

Defaults to `uploads` under the process working directory (`/data/uploads` in the Docker image).

## Restore sketch

1. Stop the target Ohiyo server.
2. Extract the tarball into a new persistent data directory.
3. Put `ohiyo.db` at the path used by `DATABASE_URL` (for Docker/Fly: `/data/ohiyo.db`).
4. Put `uploads/` under the server working directory or set `OHIYO_UPLOAD_DIR` to its path.
5. Start the same/newer Ohiyo image with a strong `JWT_SECRET` and correct `PUBLIC_BASE_URL`.
6. Users restore readable E2E history with their own device keys or personal recovery backup.
