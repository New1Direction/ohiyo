#!/usr/bin/env bash
set -euo pipefail

# Ohiyo backup restore drill.
# Restores the production SQLite DB into a temp location (from Litestream when configured,
# otherwise from a local DB file) and runs integrity/readability checks. Does NOT touch the
# live DB.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${WORKDIR:-$(mktemp -d)}"
RESTORE_DB="$WORKDIR/ohiyo-restore-drill.db"
DB_URL="${DATABASE_URL:-sqlite:$ROOT/server/kikkacord.db}"
DB_FILE="${DB_URL#sqlite:}"
DB_FILE="${DB_FILE#//}"

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
  echo "restoring from Litestream replica: $LITESTREAM_REPLICA_URL"
  litestream restore -if-replica-exists -o "$RESTORE_DB" "$LITESTREAM_REPLICA_URL"
elif [[ -f "$DB_FILE" ]]; then
  echo "copying local DB: $DB_FILE"
  cp "$DB_FILE" "$RESTORE_DB"
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
