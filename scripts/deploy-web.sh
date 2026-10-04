#!/usr/bin/env bash
# Deploy the web app (client/) to the Railway service behind app.ohiyo.gg, then tell the
# reliability check which build to expect.
#
#   scripts/deploy-web.sh
#
# Needs the Railway CLI logged in with access to the project, and `gh` for the last step.
# Run it from a directory linked to the project (`railway link`), or set
# RAILWAY_PROJECT_ID (and RAILWAY_ENVIRONMENT if it is not "production").
set -euo pipefail

SERVICE="${RAILWAY_WEB_SERVICE:-ohiyo-web}"
APP_URL="${APP_URL:-https://app.ohiyo.gg}"
REPO="${GITHUB_REPOSITORY:-New1Direction/ohiyo}"
root="$(cd "$(dirname "$0")/.." && pwd)"

target=()
if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  target=(--project "$RAILWAY_PROJECT_ID" --environment "${RAILWAY_ENVIRONMENT:-production}")
fi

# Builds client/Dockerfile on Railway and waits for the deploy to finish.
railway up "$root/client" --path-as-root --service "$SERVICE" --ci "${target[@]}"

# Read the asset names the live site now serves.
page="$(curl -fsS --max-time 20 "$APP_URL/")"
js="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' <<<"$page" | head -1)"
css="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.css' <<<"$page" | head -1)"
if [[ -z "$js" || -z "$css" ]]; then
  echo "Could not find the bundle names at $APP_URL; set OHIYO_EXPECTED_APP_BUNDLE by hand." >&2
  exit 1
fi
echo "Live bundle: $js, $css"

# The scheduled reliability check compares the live bundle with this variable.
gh variable set OHIYO_EXPECTED_APP_BUNDLE --repo "$REPO" --body "$js,$css"
echo "OHIYO_EXPECTED_APP_BUNDLE updated."
