#!/bin/sh
# Foreground entry point for the ImOrb's existing service supervisor.
set -eu
cd "$(dirname "$0")"
: "${BURROW_BROWSER_EGRESS_ENFORCED:?Configure upstream browser/sidecar network policy first}"
export BURROW_BROWSER_TOKEN_FILE=/run/burrow-browser/token
export BURROW_BROWSER_SCOPE_FILE=/run/burrow-browser/scope.json
export BURROW_BROWSER_CDP_URL="${BURROW_BROWSER_CDP_URL:-http://127.0.0.1:9222}"
exec .venv/bin/python service.py
