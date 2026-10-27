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

# Upload the repository root: the client imports shared brand assets outside client/.
# In Railway, leave Root Directory at / and set dockerfilePath directly to
# client/Dockerfile (builder RAILPACK), health check /, timeout 60s (see DEPLOY.md).
# railwayConfigFile is deprecated; nested client/railway.json is reference only.
railway up "$root" --path-as-root --service "$SERVICE" --ci "${target[@]}"

# Validate the live graph before updating freshness. Vite may load all CSS from JS.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
curl -fsS --max-time 20 "${APP_URL%/}/" > "$workdir/app.html"
if ! assets="$(python3 "$root/scripts/app-bundle-assets.py" "$APP_URL" "$workdir/app.html")"; then
  echo "Could not validate the bundles at $APP_URL; expected bundle variable was not updated." >&2
  exit 1
fi
js="$(grep -E '^assets/index-[A-Za-z0-9_-]+\.js$' <<<"$assets" | head -1)"
echo "Live bundle: $js (JS/CSS graph validated)"

# The entry JS hash identifies the build, including its lazy CSS dependencies.
gh variable set OHIYO_EXPECTED_APP_BUNDLE --repo "$REPO" --body "$js"
echo "OHIYO_EXPECTED_APP_BUNDLE updated."
