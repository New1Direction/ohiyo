#!/usr/bin/env bash
set -euo pipefail

# Ohiyo backup restore drill.
# Restores the production SQLite DB into a temp location (from Litestream when configured,
# otherwise from a local DB file) and runs integrity/readability checks. Does NOT touch the
# live DB.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# WORKDIR is a parent directory, never a directory this script owns or deletes.
# Backup files may contain private data; create a private child for this drill.
umask 077
WORKDIR="$(mktemp -d "${WORKDIR:-${TMPDIR:-/tmp}}/ohiyo-restore-drill.XXXXXX")"
RESTORE_DB="$WORKDIR/ohiyo-restore-drill.db"
DB_URL="${DATABASE_URL:-sqlite:$ROOT/server/kikkacord.db}"
DB_FILE="${DB_URL#sqlite:}"
DB_FILE="${DB_FILE#//}"
DB_FILE="${DB_FILE%%\?*}"

cleanup() {
  if [[ "${KEEP_RESTORE_DRILL:-0}" != "1" ]]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

printf 'restore drill workdir: %s\n' "$WORKDIR"

if [[ -n "${LITESTREAM_REPLICA_URL:-}" ]]; then
  if ! command -v litestream >/dev/null 2>&1; then
    echo "litestream not found; install it or run inside the server image" >&2
    exit 1
  fi
  if [[ -n "${LITESTREAM_ENDPOINT:-}" ]]; then
    # Stores other than AWS S3 (Cloudflare R2 for the hosted service): Litestream takes
    # the endpoint only from a config file. Same config as the server image uses.
    echo "restoring from Litestream replica: $LITESTREAM_REPLICA_URL at $LITESTREAM_ENDPOINT"
    "$ROOT/server/litestream-config.sh" "$RESTORE_DB" > "$WORKDIR/litestream.yml"
    litestream restore -config "$WORKDIR/litestream.yml" -if-replica-exists "$RESTORE_DB"
  else
    echo "restoring from Litestream replica: $LITESTREAM_REPLICA_URL"
    litestream restore -if-replica-exists -o "$RESTORE_DB" "$LITESTREAM_REPLICA_URL"
  fi
  if [[ ! -f "$RESTORE_DB" ]]; then
    echo "the replica has no backup to restore" >&2
    exit 1
  fi
elif [[ -f "$DB_FILE" ]]; then
  echo "taking a consistent SQLite snapshot"
  python3 - "$DB_FILE" "$RESTORE_DB" <<'PY'
import pathlib, sqlite3, sys
source = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'
with sqlite3.connect(source, uri=True) as original, sqlite3.connect(sys.argv[2]) as snapshot:
    original.backup(snapshot)
PY
else
  echo "no LITESTREAM_REPLICA_URL and DB file not found at $DB_FILE" >&2
  exit 1
fi

python3 - "$RESTORE_DB" <<'PY'
import sqlite3, sys
path = sys.argv[1]
con = sqlite3.connect(path)
cur = con.cursor()
integrity = cur.execute('PRAGMA integrity_check').fetchone()[0]
if integrity != 'ok':
    raise SystemExit(f'integrity_check failed: {integrity}')
required = ['users','servers','channels','messages','hosted_instances']
existing = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
missing = [t for t in required if t not in existing]
if missing:
    raise SystemExit(f'missing required tables: {missing}')
print('integrity_check=ok')
for table in required:
    count = cur.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    print(f'{table}={count}')
con.close()
PY

echo "restore drill passed"
echo "restored copy: $RESTORE_DB"
