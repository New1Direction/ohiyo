#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-https://api.ohiyo.gg/api/v1}"
NAME="${NAME:-Launch Smoke}"
KEEP="${KEEP:-0}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}
need curl
need jq

suffix="$(date +%Y%m%d%H%M%S)-$RANDOM"
username="${SMOKE_USERNAME:-smoke-$suffix}"
password="${SMOKE_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n' 2>/dev/null || uuidgen)-Aa1!}"

if [[ -n "${SMOKE_USERNAME:-}" && -n "${SMOKE_PASSWORD:-}" ]]; then
  echo "Logging in smoke user $SMOKE_USERNAME against $API_BASE ..."
  auth_json="$(curl -fsS "$API_BASE/auth/login" \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg username "$username" --arg password "$password" '{username:$username,password:$password}')")"
else
  echo "Registering temporary smoke user against $API_BASE ..."
  auth_json="$(curl -fsS "$API_BASE/auth/register" \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg username "$username" --arg password "$password" '{username:$username,password:$password,display_name:"Launch Smoke"}')")"
fi
token="$(jq -r '.token' <<<"$auth_json")"
if [[ -z "$token" || "$token" == "null" ]]; then
  echo "No token returned from auth" >&2
  exit 1
fi

instance_id=""
subdomain=""
cleanup() {
  if [[ "$KEEP" != "1" && -n "$instance_id" ]]; then
    echo "Cleaning up instance $instance_id ..."
    curl -fsS -X DELETE "$API_BASE/instances/$instance_id" -H "authorization: Bearer $token" >/dev/null || \
      echo "WARN: cleanup DELETE failed for $instance_id" >&2
  fi
}
trap cleanup EXIT

echo "Creating Instant Server instance ..."
inst_json="$(curl -fsS "$API_BASE/instances" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $token" \
  --data "$(jq -cn --arg name "$NAME" '{name:$name}')")"
instance_id="$(jq -r '.id' <<<"$inst_json")"
subdomain="$(jq -r '.subdomain' <<<"$inst_json")"
public_url="$(jq -r '.public_url' <<<"$inst_json")"
status="$(jq -r '.status' <<<"$inst_json")"

echo "Created: id=$instance_id status=$status url=$public_url"
if [[ "$status" != "healthy" || -z "$subdomain" || "$subdomain" == "null" ]]; then
  echo "Instance did not become healthy" >&2
  exit 1
fi

health_url="https://$subdomain.ohiyo.gg/healthz"
echo "Waiting for routed health check: $health_url"
for i in {1..24}; do
  body="$(curl -fsS --max-time 8 "$health_url" 2>/dev/null || true)"
  if [[ "$body" == "ok" ]]; then
    echo "Instant Server smoke passed: $health_url -> ok"
    exit 0
  fi
  sleep 5
done

echo "Timed out waiting for $health_url" >&2
exit 1
