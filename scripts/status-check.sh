#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-https://app.ohiyo.gg}"
LANDING_URL="${LANDING_URL:-https://ohiyo.gg}"
API_URL="${API_URL:-https://ohiyo.fly.dev}"
STATUS_URL="${STATUS_URL:-$API_URL/api/v1/reliability/status}"
PUSH_CONFIG_URL="${PUSH_CONFIG_URL:-$API_URL/api/v1/push/config}"
EXPECTED_APP_BUNDLE="${EXPECTED_APP_BUNDLE:-}"
CHECK_INSTANT_SERVER_PROVISION="${CHECK_INSTANT_SERVER_PROVISION:-0}"
INSTANT_API_BASE="${INSTANT_API_BASE:-$API_URL/api/v1}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0
failure_lines=()

record_failure() {
  local message="$1"
  echo "FAIL $message" >&2
  failures=$((failures+1))
  failure_lines+=("$message")
}

check() {
  local name="$1" url="$2" out="$3"
  local code
  code="$(curl -L -sS --max-time 20 -o "$out" -w '%{http_code}' "$url" || true)"
  if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
    echo "ok $name $code $url"
  else
    record_failure "$name returned HTTP ${code:-curl-error} for $url"
  fi
}

json_get() {
  local file="$1" expr="$2"
  jq -r "$expr" "$file" 2>/dev/null || true
}

send_alert() {
  if [[ "$failures" -eq 0 || -z "${ALERT_WEBHOOK_URL:-}" ]]; then
    return 0
  fi

  local detail text payload
  detail="$(printf '%s\n' "${failure_lines[@]}" | sed 's/^/- /')"
  text="Ohiyo beta reliability check failed: $failures failure(s)\n$detail"
  payload="$(jq -nc --arg text "$text" '{text:$text, content:$text}')"
  curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || \
    echo "WARN alert webhook delivery failed" >&2
}

landing_html="$workdir/landing.html"
app_html="$workdir/app.html"
health_body="$workdir/health.txt"
status_json="$workdir/status.json"
push_json="$workdir/push.json"

check landing "$LANDING_URL" "$landing_html"
check app "$APP_URL" "$app_html"
check api-health "$API_URL/healthz" "$health_body"
check api-status "$STATUS_URL" "$status_json"
check push-config "$PUSH_CONFIG_URL" "$push_json"

if [[ -s "$health_body" ]]; then
  health_trimmed="$(tr -d '\r\n' < "$health_body")"
  if [[ "$health_trimmed" != "ok" ]]; then
    record_failure "api-health body was '$health_trimmed' instead of 'ok'"
  fi
fi

if [[ -s "$app_html" ]]; then
  app_assets=()
  while IFS= read -r asset; do
    app_assets+=("$asset")
  done < <(grep -Eo "assets/index-[^\"'<> ]+\\.(js|css)" "$app_html" | sort -u || true)
  js_count="$(printf '%s\n' "${app_assets[@]:-}" | grep -c '\.js$' || true)"
  css_count="$(printf '%s\n' "${app_assets[@]:-}" | grep -c '\.css$' || true)"
  if [[ "$js_count" -lt 1 || "$css_count" -lt 1 ]]; then
    record_failure "app bundle missing index JS/CSS assets in $APP_URL"
  else
    echo "ok app-bundle ${app_assets[*]}"
    for asset in "${app_assets[@]}"; do
      check "app-asset:$asset" "$APP_URL/$asset" "$workdir/asset-$(basename "$asset")"
    done
  fi

  if [[ -n "$EXPECTED_APP_BUNDLE" ]]; then
    IFS=',' read -r -a expected_assets <<< "$EXPECTED_APP_BUNDLE"
    for expected in "${expected_assets[@]}"; do
      expected="${expected# }"
      expected="${expected% }"
      if [[ -n "$expected" && " ${app_assets[*]:-} " != *" $expected "* ]]; then
        record_failure "app appears stale: expected bundle asset '$expected' was not served by $APP_URL"
      fi
    done
  fi
fi

if command -v jq >/dev/null 2>&1; then
  if [[ -s "$status_json" ]]; then
    status_ok="$(json_get "$status_json" '.ok')"
    if [[ "$status_ok" != "true" ]]; then
      record_failure "reliability status ok=false"
    fi

    while IFS=$'\t' read -r name status detail; do
      [[ -z "$name" ]] && continue
      echo "component $name=$status — $detail"
      if [[ "$status" != "ok" ]]; then
        record_failure "component $name reported $status — $detail"
      fi
    done < <(jq -r '.components[]? | [.name, .status, .detail] | @tsv' "$status_json" 2>/dev/null || true)

    for required in database gateway voice instant_servers push_relay; do
      if ! jq -e --arg name "$required" '.components[]? | select(.name == $name)' "$status_json" >/dev/null 2>&1; then
        record_failure "reliability status missing component '$required'"
      fi
    done
  fi

  if [[ -s "$push_json" ]]; then
    push_enabled="$(json_get "$push_json" '.enabled')"
    vapid_key="$(json_get "$push_json" '.vapid_public_key // empty')"
    if [[ "$push_enabled" != "true" ]]; then
      record_failure "push config disabled (enabled=$push_enabled)"
    elif [[ -z "$vapid_key" || "$vapid_key" == "null" ]]; then
      record_failure "push config missing VAPID public key"
    else
      echo "ok push-config enabled=true has_vapid_key=true"
    fi
  fi
else
  record_failure "jq is required for JSON reliability checks"
fi

check_instant_lower="$(printf '%s' "$CHECK_INSTANT_SERVER_PROVISION" | tr '[:upper:]' '[:lower:]')"
case "$check_instant_lower" in
  1|true|yes)
    echo "Running Instant Server provision smoke against $INSTANT_API_BASE ..."
    if API_BASE="$INSTANT_API_BASE" NAME="Reliability Smoke" scripts/instant-server-prod-smoke.sh; then
      echo "ok instant-server-provision"
    else
      record_failure "Instant Server provision smoke failed against $INSTANT_API_BASE"
    fi
    ;;
  *)
    echo "skip instant-server-provision (set CHECK_INSTANT_SERVER_PROVISION=1 to run create/health/delete smoke)"
    ;;
esac

send_alert

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
