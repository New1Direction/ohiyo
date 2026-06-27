#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/setup-apple-signing-secrets.sh \
    --p12 /path/to/DeveloperIDApplication.p12 \
    --identity "Developer ID Application: Name (TEAMID)" \
    --apple-id you@example.com \
    --team-id TEAMID [--repo owner/repo]

This stores the required macOS Developer ID signing/notarization values as
GitHub Actions secrets. It never prints secret values.

You will be prompted for:
  - the .p12 export password
  - the Apple app-specific password used by notarytool

Optional:
  APPLE_PROVIDER_SHORT_NAME can be set in the environment before running this
  script, or passed with --provider-short-name VALUE.
EOF
}

repo="New1Direction/ohiyo"
p12=""
identity=""
apple_id=""
team_id=""
provider="${APPLE_PROVIDER_SHORT_NAME:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --p12) p12="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --apple-id) apple_id="${2:-}"; shift 2 ;;
    --team-id) team_id="${2:-}"; shift 2 ;;
    --provider-short-name) provider="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$p12" || -z "$identity" || -z "$apple_id" || -z "$team_id" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -f "$p12" ]]; then
  echo "Certificate file not found: $p12" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
openssl base64 -A -in "$p12" -out "$tmp"

read -r -s -p "Password for the .p12 export: " cert_password
echo
read -r -s -p "Apple app-specific password for notarization: " apple_password
echo

if [[ -z "$cert_password" || -z "$apple_password" ]]; then
  echo "Passwords cannot be empty." >&2
  exit 1
fi

gh secret set APPLE_CERTIFICATE --repo "$repo" < "$tmp"
printf '%s' "$cert_password" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$repo"
printf '%s' "$identity" | gh secret set APPLE_SIGNING_IDENTITY --repo "$repo"
printf '%s' "$apple_id" | gh secret set APPLE_ID --repo "$repo"
printf '%s' "$apple_password" | gh secret set APPLE_PASSWORD --repo "$repo"
printf '%s' "$team_id" | gh secret set APPLE_TEAM_ID --repo "$repo"
if [[ -n "$provider" ]]; then
  printf '%s' "$provider" | gh secret set APPLE_PROVIDER_SHORT_NAME --repo "$repo"
fi

echo "Apple signing secrets saved for $repo. Next: run the Release workflow or push a v* tag."
