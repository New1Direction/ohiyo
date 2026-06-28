#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-https://app.ohiyo.gg}"
LANDING_URL="${LANDING_URL:-https://ohiyo.gg}"
API_URL="${API_URL:-https://ohiyo.fly.dev}"
STATUS_URL="$API_URL/api/v1/reliability/status"

failures=0
check() {
  local name="$1" url="$2"
  local code
  code="$(curl -L -sS -o /tmp/ohiyo-status-check.out -w '%{http_code}' "$url" || true)"
  if [[ "$code" =~ ^2|3 ]]; then
    echo "ok $name $code $url"
  else
    echo "FAIL $name $code $url" >&2
    failures=$((failures+1))
  fi
}

check landing "$LANDING_URL"
check app "$APP_URL"
check api-health "$API_URL/healthz"
check api-status "$STATUS_URL"

if command -v jq >/dev/null 2>&1; then
  curl -fsS "$STATUS_URL" | jq -r '.components[] | "component \(.name)=\(.status) — \(.detail)"' || failures=$((failures+1))
fi

if [[ "$failures" -gt 0 && -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  payload="{\"text\":\"Ohiyo status check failed: $failures failure(s). API: $API_URL\"}"
  curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
fi

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
