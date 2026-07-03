# Ohiyo launch status

_Last checked: 2026-07-03_

## Web beta ready

- `https://ohiyo.gg` returns 200 and serves the public landing site.
- `https://app.ohiyo.gg` returns 200 and serves the current React bundle:
  - `assets/index-BjorZsew.js`
  - `assets/index-DGqrrC5D.css`
- `https://ohiyo.fly.dev/healthz` returns `ok`.
- `https://api.ohiyo.gg/healthz` returns `ok`.
- `https://ohiyo.fly.dev/api/v1/reliability/status` reports all public components `ok`.
- `https://ohiyo.fly.dev/api/v1/push/config` reports Web Push `enabled=true` with a VAPID public key.
- Production backend exposes current v0.2 routes; auth-gated routes return `401` instead of stale `404`.
- Current deployed app bundle includes launch modal polish from `4a793e2` (`Polish launch modal surfaces`).
- GitHub CI is green on `main`.
- GitHub 28-suite E2E is green on `main` in both dev and production-preview modes.
- GitHub Reliability Alerts is green on `main`.
- `OHIYO_EXPECTED_APP_BUNDLE` is set to the current Cloudflare Pages assets so scheduled alerts catch stale app deploys.
- Fly app `ohiyo` is running and DB-backed health checks pass.
- Fly provisioning secrets for Instant Servers are deployed and wildcard `*.ohiyo.gg` reaches the router.
- Production Instant Server smoke passed: a temporary instance at `https://reliability-smoke-02627b.ohiyo.gg/healthz` returned `ok`, then cleanup deleted the machine/volume/registry row.
- Local backup restore drill passed: copied `server/kikkacord.db`, `PRAGMA integrity_check` returned `ok`, and core tables/counts were readable.
- Landing site has Privacy, Terms, robots.txt, sitemap.xml, and security.txt.
- Working tree is clean; deferred pitch/demo artifacts are preserved in `stash@{0}` (`defer launch marketing and demo artifacts`).

## Remaining launch operator setup

- Add a real `ALERT_WEBHOOK_URL` GitHub secret so Reliability Alerts page a human. The workflow is installed and passing; only the receiver URL is missing.
- Recommended: add `OHIYO_RELIABILITY_SMOKE_USERNAME` and `OHIYO_RELIABILITY_SMOKE_PASSWORD` GitHub secrets for the daily Instant Server smoke. Without these, the smoke script registers a temporary user before creating/deleting the instance.
- After any manual Cloudflare Pages deploy, update `OHIYO_EXPECTED_APP_BUNDLE` to the new `assets/index-*.js,assets/index-*.css` pair.

## Not blocking web launch

- Public macOS desktop downloads are paused until Developer ID signing/notarization is configured.
- Windows desktop builds are still disabled until the key-vault dependency is made Windows-compatible.
- Litestream continuous backup is documented but not configured; Fly daily snapshots plus backup-restore drills are the current baseline.
- APNs/FCM native push credentials are not configured; production Web Push is live and content-free.

## Before broad desktop launch

1. Add Apple Developer ID/notarization secrets to GitHub Actions:
   - `APPLE_CERTIFICATE`
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY`
   - `APPLE_ID`
   - `APPLE_PASSWORD`
   - `APPLE_TEAM_ID`
2. Run the Release workflow and verify notarized Apple Silicon + Intel DMGs on a clean Mac.
3. Flip `macDownloadsTrusted` in `site/app.js` to `true` only after verification.
4. Re-enable direct Mac download copy on the landing page.

## Final smoke commands

```bash
EXPECTED_APP_BUNDLE='assets/index-BjorZsew.js,assets/index-DGqrrC5D.css' scripts/status-check.sh
EXPECTED_APP_BUNDLE='assets/index-BjorZsew.js,assets/index-DGqrrC5D.css' CHECK_INSTANT_SERVER_PROVISION=1 scripts/status-check.sh
scripts/backup-restore-drill.sh
```
