#!/bin/sh
set -e

# Continuous SQLite backup via Litestream — fully OPT-IN.
#
# With LITESTREAM_REPLICA_URL unset (the default) this is a transparent passthrough:
# it execs the server exactly as before, so existing deployments are unaffected.
#
# With it set (plus object-store credentials — see infra/litestream/README.md) the DB
# is restored from the replica on a fresh/empty volume, then continuously streamed to
# object storage. Stores other than AWS S3 (Cloudflare R2 for the hosted service) also
# need LITESTREAM_ENDPOINT, which goes into a config file (litestream-config.sh).

# Litestream needs the file path, not the `sqlite:` URL the app uses, and not the
# connection options sqlx accepts after a `?`.
DB_FILE="${DATABASE_URL#sqlite:}"
DB_FILE="${DB_FILE%%\?*}"
DB_FILE="${DB_FILE:-/data/ohiyo.db}"

if [ -z "$LITESTREAM_REPLICA_URL" ]; then
  exec ohiyo-server
fi

CONFIG=""
if [ -n "$LITESTREAM_ENDPOINT" ]; then
  CONFIG="${TMPDIR:-/tmp}/ohiyo-litestream.yml"
  "$(dirname "$0")/litestream-config.sh" "$DB_FILE" > "$CONFIG"
  echo "litestream: $DB_FILE -> $LITESTREAM_REPLICA_URL at $LITESTREAM_ENDPOINT"
else
  echo "litestream: $DB_FILE -> $LITESTREAM_REPLICA_URL"
fi

# Restore only when this volume has no database (first boot after losing the volume).
# With a database present the store is not asked at all, so a store that can't be
# reached never keeps a working server down. With no database a failed restore stops
# the boot (set -e): starting empty would hide the loss, and the empty database would
# start replacing the good copy. An empty store (the very first deploy) is fine:
# -if-replica-exists makes that a no-op.
if [ ! -e "$DB_FILE" ]; then
  if [ -n "$CONFIG" ]; then
    litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB_FILE"
  else
    litestream restore -if-db-not-exists -if-replica-exists -o "$DB_FILE" "$LITESTREAM_REPLICA_URL"
  fi
fi

# Replicate while running the server as a managed subprocess.
if [ -n "$CONFIG" ]; then
  exec litestream replicate -config "$CONFIG" -exec ohiyo-server
fi
exec litestream replicate -exec ohiyo-server "$DB_FILE" "$LITESTREAM_REPLICA_URL"
