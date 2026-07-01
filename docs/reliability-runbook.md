# Ohiyo Reliability Runbook

This is the beta reliability checklist for the hosted service and Instant Servers.

## Daily/weekly checks

- GitHub Actions **Reliability Alerts** runs every 30 minutes against production:
  - `https://ohiyo.gg`
  - `https://app.ohiyo.gg`
  - `https://ohiyo.fly.dev/healthz`
  - `https://ohiyo.fly.dev/api/v1/reliability/status`
  - `https://ohiyo.fly.dev/api/v1/push/config`
- The same workflow runs one daily Instant Server create → routed `/healthz` → delete smoke at `08:17 UTC`.
- `scripts/status-check.sh` is the local/CI entrypoint. It checks landing/app/API/push health, confirms the app serves index JS/CSS bundles, validates reliability components, validates Web Push is enabled with a VAPID public key, and can run the Instant Server smoke.
- GitHub Actions CI must stay green on `main`.
- Fly app `ohiyo` health checks must stay green.
- Review error logs after deploys: `fly logs -a ohiyo`.

### Alert setup

1. Add a repository secret named `ALERT_WEBHOOK_URL` with a Slack-compatible, Discord-compatible, or custom JSON webhook URL.
2. Recommended for the daily Instant Server smoke: create a low-privilege production account dedicated to reliability checks and add repository secrets `OHIYO_RELIABILITY_SMOKE_USERNAME` and `OHIYO_RELIABILITY_SMOKE_PASSWORD`. If these are absent, the smoke script registers a temporary user before creating/deleting the hosted instance.
3. Optional stale-bundle guard: add a repository variable named `OHIYO_EXPECTED_APP_BUNDLE` after manual Cloudflare Pages deploys, using comma-separated live asset paths, for example:

   ```txt
   assets/index-C4w_KSpS.js,assets/index-hNuzaEh9.css
   ```

   If this variable is unset, the check still fails on missing/unreachable app bundles, but does not assert a specific hash.
4. To run manually in GitHub, open **Actions → Reliability Alerts → Run workflow**. Enable `instant_server_smoke` when you want to create and delete a temporary hosted instance immediately.

Local equivalents:

```bash
# Public health/app/push/status checks only.
scripts/status-check.sh

# Send an alert webhook if anything fails.
ALERT_WEBHOOK_URL=https://hooks.example/... scripts/status-check.sh

# Include the production Instant Server provision smoke.
CHECK_INSTANT_SERVER_PROVISION=1 scripts/status-check.sh
```

The webhook payload contains both `text` and `content` fields so Slack-style and Discord-style receivers can display it. It lists each failed check.

## Backup restore drills

Run at least weekly and before launch milestones:

```bash
# Local DB copy drill
scripts/backup-restore-drill.sh

# Litestream/object-store drill, when replica is configured
LITESTREAM_REPLICA_URL=s3://bucket/path/to/ohiyo.db scripts/backup-restore-drill.sh
```

Pass criteria:

- Restore happens into a temp directory, never over live data.
- `PRAGMA integrity_check` returns `ok`.
- Core tables exist: `users`, `servers`, `channels`, `messages`, `hosted_instances`.
- Counts are plausible and recorded in the incident/drill log.

## Status page

Public page: `https://ohiyo.gg/status.html`

Machine-readable summary:

- `https://ohiyo.fly.dev/healthz` — load balancer readiness, DB-backed.
- `https://ohiyo.fly.dev/api/v1/reliability/status` — component summary, no secrets/content.
- `https://ohiyo.fly.dev/api/v1/reliability/cost-model` — public planning cost model.

## Observability

Current baseline:

- Structured Rust logs via `tracing`.
- Fly health checks for `/healthz`.
- Public component status summary.
- CI gates: server fmt/clippy/tests, client typecheck/lint/unit/build, targeted E2E.
- Scheduled beta alerts for landing/app/API health, reliability components, app bundle presence/staleness, push config, and daily Instant Server provisioning.

Next production step:

- Add a real log/metrics sink (Better Stack, Grafana Cloud, Sentry, Honeycomb, etc.).
- Alert on websocket error spikes, disk usage >80%, DB latency/error rates, and push delivery failure rates from server-side metrics/logs, not just public status probes.

## Load testing

Small smoke:

```bash
USERS=5 MESSAGES_PER_USER=10 scripts/load-gateway-smoke.mjs
```

Staging ramp:

```bash
E2E_API=https://staging-api.example/api/v1 \
KIKKA_ORIGIN=https://staging-app.example \
USERS=25 MESSAGES_PER_USER=50 \
scripts/load-gateway-smoke.mjs
```

Do not run large load tests against production without a window and rollback plan.

## Cost model

See `docs/hosted-community-cost-model.md` and the live JSON endpoint:

```bash
curl 'https://ohiyo.fly.dev/api/v1/reliability/cost-model?communities=100&paid=20&free_active_ratio=0.15' | jq
```

The model is deliberately public and approximate. Replace assumptions with actual invoice data as usage grows.
