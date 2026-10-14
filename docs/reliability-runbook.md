# Ohiyo Reliability Runbook

This is the beta reliability checklist for the hosted service and Instant Servers.

## Daily/weekly checks

- GitHub Actions **Reliability Alerts** runs every 30 minutes against production:
  - `https://ohiyo.gg`
  - `https://app.ohiyo.gg`
  - `https://ohiyo-server-production.up.railway.app/healthz`
  - `https://ohiyo-server-production.up.railway.app/api/v1/reliability/status`
  - `https://ohiyo-server-production.up.railway.app/api/v1/push/config`
- The same workflow runs one daily Instant Server create → routed `/healthz` → delete smoke at `08:17 UTC`.
- `scripts/status-check.sh` is the local/CI entrypoint. It checks landing/app/API/push health, confirms the app serves index JS/CSS bundles, validates reliability components, validates Web Push is enabled with a VAPID public key, and can run the Instant Server smoke.
- GitHub Actions CI must stay green on `main`.
- Fly app `ohiyo` health checks must stay green.
- Review error logs after deploys: `fly logs -a ohiyo`.

### Alert setup

1. Add a repository secret named `ALERT_WEBHOOK_URL`. Production uses an ntfy.sh topic (`https://ntfy.sh/<topic>`):
   install the ntfy app and subscribe to the topic to get a phone notification. The topic name is the only
   thing that protects it, so keep it long and random. A Slack or Discord webhook URL works too (it gets
   JSON); a self-hosted ntfy server needs `ALERT_WEBHOOK_FORMAT=ntfy` in the workflow's env.
2. Recommended for the daily Instant Server smoke: create a low-privilege production account dedicated to reliability checks and add repository secrets `OHIYO_RELIABILITY_SMOKE_USERNAME` and `OHIYO_RELIABILITY_SMOKE_PASSWORD`. If these are absent, the smoke script registers a temporary user before creating/deleting the hosted instance.
3. Stale-bundle guard: the repository variable `OHIYO_EXPECTED_APP_BUNDLE` names the live app's asset files, so the check notices a deploy that didn't take. `scripts/deploy-web.sh` sets it after every web deploy; set it by hand only if you deploy some other way. It holds comma-separated asset paths, for example:

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

## Paid Instant Servers

### Launch gates and safe validation

Do not enable paid hosting based on green unit tests alone. The hosted Railway API
does not implement a Railway provisioner or Fly replay routing. Confirm the chosen
control plane and wildcard community domains route to the intended Fly machine, with
TLS, persistent storage, export/restore and externally reachable `/healthz` working.
Run a **single control-plane process per SQLite database**: the lifecycle lock covers
checkout, webhook, account deletion, provisioning and reconciliation in that process,
not multiple replicas. Do not run old and new binaries against one writable database.

Local regression command (no Stripe account, cloud credentials or real charges):

```bash
cd server
cargo test --locked --test instance_billing --test instances --test delete_account
```

This drives the shipping HTTP router, SQLite migrations, real Stripe HTTP adapter and
signed webhooks against an isolated local Stripe stand-in and simulated machines.
It does **not** prove Stripe dashboard configuration, tax/invoice requirements, card
networks, Fly scheduling, data persistence or DNS/TLS. On separately authorized staging,
use Stripe **test-mode** credentials and test cards; never copy a live webhook signing
secret into a fixture. A debug/simulated provisioner refuses live-mode keys.

Before live sales, record evidence of checkout → paid → stopped-machine recovery →
portal payment-method update → renewal failure → recovery → period-end cancellation →
free → export → instance/account deletion. Check the Stripe dashboard and cloud resource
list as well as the app. Verify no second subscription or leftover machine/volume.
Configure retries to leave `past_due` eventually, and disable portal price/quantity
changes. The beta's "stays on" promise is no automatic sleep, not guaranteed uptime.

### Signals and recovery

The separate billing worker runs every five minutes. It retrieves current subscriptions
and completed checkout sessions, retries uncertain checkout creation under its saved
idempotency key, updates entitlements atomically, and checks/restarts paid machines.
One row failure does not prevent other rows from recovering. It is **not** a global
Stripe inventory scanner: unknown subscriptions and cloud resources still need operator
inventory review after an outage or database restore.

Route these structured `tracing` signals to the deployment's log sink before launch:

| Signal | Action |
|---|---|
| `billing webhook processed` (`event_id`, `kind`, `applied`) | Correlate delivery with Stripe; never log payloads/signatures or checkout/portal URLs. |
| `billing reconciliation completed` (`checked`, `failed`) | Alert if missing for 15 minutes, or `failed > 0` for two sweeps. No configured billing means no sweep log. |
| `billing reconciliation row failed` | Identify the instance, inspect current Stripe state, then retry/replay after fixing provider/configuration errors. |
| `paid machine recovery failed` | Check machine state, routed health, persistent volume and Fly incidents. Do not recreate a missing machine blindly. |
| `cancelling a subscription with no unpaid server behind it` | Review the duplicate/orphan subscription and any charge; cancellation is automatic, **refunds are manual and need authorization**. |
| `billing provider call failed` / webhook 5xx | Preserve event IDs and durable rows; Stripe retries failed deliveries. Reconciliation is the fallback for lost deliveries. |

These are log signals and recommended thresholds, **not configured production alerts**.
The public status endpoint is not proof of billing health. Do not remove Stripe keys
to stop sales if customers already exist: it also stops cancellation, portal and recovery.
Disable the checkout route at the ingress while retaining webhooks/portal/cancellation.

Useful **read-only** checks against an authorized database copy:

```sql
-- Entitlement drift (operator comps without subscriptions are intentionally excluded).
SELECT h.id, h.tier, s.status FROM hosted_instances h
JOIN instance_subscriptions s ON s.instance_id = h.id
WHERE h.tier != CASE WHEN s.status IN ('active','trialing','past_due') THEN 'paid' ELSE 'free' END;
-- Recovery backlog / old pending checkouts.
SELECT instance_id, status, updated_at FROM instance_subscriptions
WHERE status = 'checkout_pending' OR status = 'past_due';
-- Retained billing tombstones; inspect nonterminal subscriptions in Stripe.
SELECT s.instance_id, s.status FROM instance_subscriptions s
LEFT JOIN hosted_instances h ON h.id = s.instance_id WHERE h.id IS NULL;
```

For "checkout needs operator reconciliation", locate the session via Stripe request
logs/idempotency key and the instance metadata. After 23 hours an uncertain request is
not automatically recreated because Stripe can discard idempotency keys after 24 hours.
Confirm whether payment occurred; cancel duplicate/live orphan subscriptions and obtain
refund approval where needed. Only then perform an approved, backed-up DB repair to link
the recovered session/subscription or clear a proven expired attempt. Do not clear event
dedupe rows or grant a paid tier based on a redirect. Replayed events fetch current Stripe
state; same-second or reordered snapshots cannot restore a cancelled subscription.

Account deletion retains billing tombstones and event IDs so late events can be matched;
Stripe also retains its customer/invoice records. Do not promise deletion of all billing
records at account deletion. The control plane handles identifiers/status/timestamps,
not card details, message content or encryption keys. Hosting/exported data can include
readable server-channel messages and unencrypted files; it is not all ciphertext.

### Provisioning incidents and rollback

If provisioning times out, inventory Fly machines and volumes before retrying. Cloud
creation and a local DB write are not one transaction: a timeout/crash may leave an
orphan, and the registry's `healthy` status is not a routed application health check.
Match machine names (`ohiyo-<subdomain>`) and attached volume IDs to the registry. Never
delete an ambiguous volume until its attachment and retained customer data are checked.
Cloud cleanup or production DB repair requires explicit operator authorization.

Before rollout take a restorable DB backup; migration 0055 is additive. Roll forward
for billing failures. An old binary ignores durable checkout requests and restores the
unsafe webhook ordering logic, so do not roll back with sales or webhook processing
enabled. Keep sales paused until reconciliation, queued webhooks and inventory review
converge. Deployments and production test charges require separate authorization.

## Backup restore drills

Run at least weekly and before launch milestones:

```bash
# Local DB copy drill
scripts/backup-restore-drill.sh

# Litestream/object-store drill, when replica is configured (needs Litestream 0.3.13)
LITESTREAM_REPLICA_URL=s3://bucket/path/to/ohiyo.db scripts/backup-restore-drill.sh

# Cloudflare R2 (the hosted service) also needs the endpoint and the token's keys
LITESTREAM_REPLICA_URL=s3://ohiyo-backups/ohiyo.db \
LITESTREAM_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=... \
  scripts/backup-restore-drill.sh
```

Pass criteria:

- Restore happens into a temp directory, never over live data.
- `PRAGMA integrity_check` returns `ok`.
- Core tables exist: `users`, `servers`, `channels`, `messages`, `hosted_instances`.
- Counts are plausible and recorded in the incident/drill log.

## Status page

Public page: `https://ohiyo.gg/status.html`

Machine-readable summary:

- `https://ohiyo-server-production.up.railway.app/healthz` — load balancer readiness, DB-backed.
- `https://ohiyo-server-production.up.railway.app/api/v1/reliability/status` — component summary, no secrets/content.
- `https://ohiyo-server-production.up.railway.app/api/v1/reliability/cost-model` — public planning cost model.

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
curl 'https://ohiyo-server-production.up.railway.app/api/v1/reliability/cost-model?communities=100&paid=20&free_active_ratio=0.15' | jq
```

The model is deliberately public and approximate. Replace assumptions with actual invoice data as usage grows.
