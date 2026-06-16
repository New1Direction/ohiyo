#!/bin/sh
set -e

# Continuous SQLite backup via Litestream — fully OPT-IN.
#
# With LITESTREAM_REPLICA_URL unset (the default) this is a transparent passthrough:
# it execs the server exactly as before, so existing deployments are unaffected.
#
# With it set (plus object-store credentials — see infra/litestream/README.md) the DB
# is restored from the replica on a fresh/empty volume, then continuously streamed to
# object storage for point-in-time recovery between Fly's daily volume snapshots.

# Litestream needs the file path, not the `sqlite:` URL the app uses.
DB_FILE="${DATABASE_URL#sqlite:}"
DB_FILE="${DB_FILE:-/data/kikkacord.db}"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  echo "litestream: $DB_FILE -> $LITESTREAM_REPLICA_URL"
  # Restore only if this volume has no DB yet (e.g. first boot after volume loss);
  # a no-op when the DB already exists.
  litestream restore -if-db-not-exists -if-replica-exists -o "$DB_FILE" "$LITESTREAM_REPLICA_URL"
  # Replicate while running the server as a managed subprocess.
  exec litestream replicate -exec "kikkacord-server" "$DB_FILE" "$LITESTREAM_REPLICA_URL"
fi

exec kikkacord-server
