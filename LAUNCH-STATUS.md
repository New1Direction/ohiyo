# Ohiyo launch status

_Last full check: 2026-07-03. Open problems and new settings added 2026-10-03; the
list under "Web beta ready" has not been re-verified since July._

## Open problems (2026-10-03)

- **Instant Server provisioning returns 502 in production.** The daily smoke has failed
  every day since at least 2026-09-02 (the earliest failing run GitHub still lists is
  2026-07-09). Check `fly logs` for the provisioner error: an expired `FLY_API_TOKEN`,
  a missing `FLY_IMAGE`, or a quota. The smoke script now prints the response body.
- **Nobody was alerted**, because `ALERT_WEBHOOK_URL` is still unset (see below).
- **Nightly E2E is flaky:** 6 of the last 15 scheduled runs failed, mostly
  `28-mobile-friend-flow` and `22-group-e2e` timing out. Fix or quarantine both; a red
  nightly hides real regressions.
- **Dependency alerts are off.** Dependabot alerts and secret scanning are disabled on
  the repository and 13 Dependabot pull requests have been open since July (the Tauri
  bump among them).

## New settings in the launch-hardening release

Set these before or with the deploy:

- `OHIYO_OPERATOR_USER_IDS` (Fly secret): comma-separated user ids allowed to run
  Discord imports that read local files or use the managed bot, and to change an
  Instant Server's tier. Unset means nobody can.
- `OHIYO_DISCRAWL_MEDIA_ROOT`: the only folder the local Discrawl import reads media
  from. Needed only if that import is enabled.
- `TRUSTED_PROXY_HOPS`: not needed on Fly. Behind any other reverse proxy set it to the
  number of proxies in front of the server, or every client shares one rate-limit
  bucket.
- `OHIYO_REGISTER_LIMIT_PER_HOUR`: defaults to 10 new accounts an hour per address.
  That is tight for a campus or a mobile carrier on launch day; consider raising it.
- `OHIYO_LOGIN_LIMIT_PER_USERNAME_PER_MINUTE`: defaults to 10. Someone who keeps
  sending attempts can keep a known username from logging in while they continue;
  raise it or set `0` if that is used against your users.

Rolling back needs one SQL statement first; see "Rolling back" in `DEPLOY.md`.

The web app now ships a Cloudflare Pages `_headers` file (frame blocking and HSTS).
After the deploy, confirm with `curl -sI https://app.ohiyo.gg | grep -i -E
'x-frame-options|strict-transport'`.

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
- GitHub 28-suite E2E was green on `main` in both dev and production-preview modes on
  2026-07-03 (now flaky, see "Open problems").
- GitHub Reliability Alerts is green on `main`.
- `OHIYO_EXPECTED_APP_BUNDLE` is set to the current Cloudflare Pages assets so scheduled alerts catch stale app deploys.
- Fly app `ohiyo` is running and DB-backed health checks pass.
- Fly provisioning secrets for Instant Servers are deployed and wildcard `*.ohiyo.gg` reaches the router.
- Production Instant Server smoke passed on 2026-07-03 (failing now, see "Open
  problems"): a temporary instance at `https://reliability-smoke-02627b.ohiyo.gg/healthz` returned `ok`, then cleanup deleted the machine/volume/registry row.
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
