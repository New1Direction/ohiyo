#!/usr/bin/env bash
# Intentionally leave the server stopped, even on failure. No automatic retries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# != 1 ]]; then
  echo "usage: backup.sh /absolute/off-host-staging/backup.tar.gz" >&2
  exit 2
fi
if [[ "$1" != /* ]]; then
  echo "backup destination must be absolute and outside the data directory" >&2
  exit 2
fi
# Ignore ambient Compose overrides: stop precisely the stack whose data we copy.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
compose=(docker compose --project-directory "$HERE" --env-file "$HERE/.env" -f "$HERE/compose.yaml")
"${compose[@]}" stop server
ids="$("${compose[@]}" ps --all --quiet server)"
if [[ -z "$ids" ]]; then
  echo "no server container found; refusing to infer quiescence" >&2
  exit 1
fi
while IFS= read -r id; do
  state="$(docker inspect --format '{{.State.Status}}' "$id")"
  if [[ "$state" != exited && "$state" != created ]]; then
    echo "server is not stopped; refusing backup" >&2
    exit 1
  fi
done <<< "$ids"
# Embedded worker shares this container; stopping it also stops Pi and Litestream.
python3 "$HERE/volume.py" backup "$HERE/data" "$1" --quiesced
echo "Backup complete. Server remains stopped; explicitly run docker compose start server."
