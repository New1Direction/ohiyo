# Ohiyo launch status

_Latest family-release qualification: 2026-10-24. Not cleared for daily-driver
distribution. The older dated sections below are historical, not current certification._

## Web-first candidate; production recovery gate remains open (2026-10-24)

- The family path is the browser app, not an unsigned Mac download. No Apple
  enrollment or native release is planned for this candidate. The landing page
  favors opening/installing the web app; its manifest now includes correctly sized
  192/512 icons and a separate padded maskable icon. Browser installation still
  needs device-specific qualification.
- The candidate adds single-use account recovery codes in **Settings → Account**
  and a **Forgot password?** flow. Recovery ends existing sessions and pending
  device links, requires the existing second factor when enabled, and does not
  unlock or delete encrypted chat backups. Codes must be saved in advance; there
  is no email reset. New passwords invalidate old account recovery codes.
- Kikka follows Burrow's selected color live, including animated states and the
  reduced-motion fallback. The original palette remains unchanged; selections
  persist across reloads.
- A fresh temporary Chrome 156 profile on macOS 26.5.1 passed signup, chat,
  recovery setup, signout/reset and signing back in with the original message
  preserved. Old passwords and consumed codes returned 401. Live Kikka colors
  and reload persistence also passed. This was headless Chrome, not Safari or a
  phone. The protected preview's anonymous manifest request returns 401, so
  actual install/launch remains unqualified there. On the local production build,
  a fresh non-incognito Chromium profile reports no manifest/installability
  errors and an activated service worker; this does not qualify the public origin.
- The two failing baseline CI gates have candidate fixes: patched Zod/Happy DOM
  dependencies and a calendar E2E that uses the scheduled date across midnight
  rather than assuming the event is today. This is not a claim of deployed fixes.
- The Rust audit failure `RUSTSEC-2026-0387` was traced to both JWT providers.
  Session/provider JWTs now use AWS-LC; Web Push keeps its existing ECE encryption
  backend and uses AWS-LC for VAPID signing, accepting the same SEC1/PKCS#8 keys.
  `crypto-bigint` is absent from the lockfile and the configured audit passes,
  without adding an exception. This source fix is not a production deployment.
- A private restore of the existing production Litestream replica succeeded:
  SQLite integrity was `ok` and foreign-key violations were zero. All 17 restored
  upload references matched live paths and sizes (404,603,754 bytes total).
  **This was not an uploads restore or content-hash verification.** The shipped
  Litestream path backs up SQLite only (10-second sync, daily snapshots,
  72-hour retention). An independent uploads/volume backup schedule has not been
  established. Locate and restore a matched uploads backup, or obtain approval
  to establish coverage, before declaring recovery qualified.
- Production still runs the October 13 backend/web deployments. Their metadata
  does not identify a Git revision. Deployed Dockerfile manifests differ from
  current Railway build settings; apply the repository-root config paths in
  `DEPLOY.md` as part of an explicitly coordinated deployment, not by assuming
  that the current settings reproduce the deployed images.
- No production migration, deployment, restart or configuration change was made
  during this qualification. Burrow coding remains gated until live-model and
  isolated-computer qualification passes; local tests are not that evidence.

## Family release is blocked (2026-10-23)

- The actual public v0.3.1 Apple Silicon DMG was inspected on an arm64 Mac with
  Gatekeeper enabled. Its ad-hoc signature passes integrity verification, but
  Gatekeeper rejects the app and no notarization ticket is present. The Mac mini
  has no valid code-signing identity; the six Apple signing/notarization secrets
  are also absent from the user-owned GitHub repository. Developer ID credentials
  must be configured privately before a trusted Mac release can be produced.
- Release workflow source now rejects missing update signing, and Mac jobs reject
  missing Apple signing instead of producing an ad-hoc fallback. This is a local
  change, not a repair to the existing published downloads. Local development
  builds remain possible. See [signing setup](DEPLOY.md#5-code-signing--auto-update-required-for-release-downloads).
- The published ARM update archive verifies against the configured public key;
  an altered archive is rejected. An actual installed-app upgrade and relaunch
  remain untested. The ARM executable requires macOS 11.0 while its Info.plist
  advertises 10.13; align packaging metadata before the next release.
- Windows installers remain disabled. Phone-width browser tests are not native
  iOS or Android qualification. Confirm the family's target platforms before
  promising downloads.
- Public web/API health, bundle asset availability and Web Push configuration
  checks pass. Both the served web bundle and released ARM client still target
  `https://ohiyo-server-production.up.railway.app`. No production accounts were
  created and no real-network calls or notification deliveries were tested.
- The local restore drill had omitted committed SQLite WAL transactions. Its
  replacement uses SQLite's read-only-source backup API; a regression proves
  committed messages are restored, pending writes excluded and the source left
  unchanged. This does **not** establish production backup configuration or a
  successful production-replica restore. That restore is still a release gate.
- A lost password cannot currently be reset. Linking from an already signed-in
  device is a limited workaround, not account recovery after all sessions are lost.
  Resolve this before recommending Ohiyo as a family's only messenger.
- Burrow coding remains an operator-provisioned pilot. No live-model coding or
  isolated production-computer qualification has been completed. Ohiyo remains
  chat; Burrow is a separate agent surface.

Local checks passed: 599 Rust tests, 980 client unit tests, client lint/types/build,
and 63 browser E2E suites against a production web build and disposable database.
The browser run also exposed a logged onboarding canvas error despite passing its
assertions. A new zero-size-layout regression reproduced it; the fix passed the
signup-to-chat journey with uncaught errors now treated as failures. These checks
do not substitute for installed-native-app, production-backup or live-model tests.

No release tag, installer publication, production migration or deployment was
performed during this qualification. Existing uncommitted work must be included
in a reviewed, versioned candidate and matched with its backend before shipping.

## Hosting moved to Railway (2026-10-03)

- The backend now runs on Railway at `https://ohiyo-server-production.up.railway.app`
  with a **new, empty database**. Accounts, messages and files on the old Fly server
  were not carried over.
- The web app at `https://app.ohiyo.gg` is served from a second Railway service (built
  from `client/Dockerfile`, deployed with `scripts/deploy-web.sh`) and talks to that
  address. A browser that still has the old `ohiyo.fly.dev` home stored drops it on
  load and shows the sign-in screen.
- Desktop 0.3.0 talks to the Railway server and updates itself. 0.2.0 and older still talk
  to `ohiyo.fly.dev` and have to be replaced by hand once.
- Instant Servers are unavailable on the hosted service (they need Fly Machines); the
  server refuses to create them and the daily provisioning smoke is off.
- The paid Instant Servers plan (Stripe Checkout, webhook, customer portal, about $8 per
  community per month) is built (2026-10-13) but not sold: it needs live Instant Servers
  and the Stripe settings in `GO-LIVE.md` §3b. The app says "Paid plan unavailable" and why.
- `OHIYO_OPERATOR_USER_IDS` is set on Railway.
- Still to do by the owner: shut down the old Fly apps, and delete the unused
  Cloudflare Pages project `ohiyo-app`. The wildcard `*.ohiyo.gg` record (and so
  `api.ohiyo.gg`) still points at `ohiyo.fly.dev`; remove it or repoint it when Fly is
  shut down.
- Everything under "Web beta ready" below that names `ohiyo.fly.dev` describes the old
  host as of July.

## Open problems (2026-10-03)

- **Instant Server provisioning returned 502 on the old Fly host** (moot now that the
  hosted service does not provision them). The daily smoke had failed
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
- `https://ohiyo-server-production.up.railway.app/healthz` returns `ok`.
- `https://api.ohiyo.gg/healthz` returns `ok`.
- `https://ohiyo-server-production.up.railway.app/api/v1/reliability/status` reports all public components `ok`.
- `https://ohiyo-server-production.up.railway.app/api/v1/push/config` reports Web Push `enabled=true` with a VAPID public key.
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
- App deploys go through `scripts/deploy-web.sh`, which updates `OHIYO_EXPECTED_APP_BUNDLE` to the new `assets/index-*.js,assets/index-*.css` pair. After a deploy made any other way, update it by hand.

## Not blocking web launch

- macOS desktop downloads are public as an ad-hoc-signed beta; Developer ID signing/notarization is still to do.
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
