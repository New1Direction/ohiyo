# Ohiyo Reliability Runbook

This is the beta reliability checklist for the hosted service and Instant Servers.

## Daily/weekly checks

- `scripts/status-check.sh` — checks landing, app, API `/healthz`, and `/api/v1/reliability/status`.
- GitHub Actions CI must stay green on `main`.
- Fly app `ohiyo` health checks must stay green.
- Review error logs after deploys: `fly logs -a ohiyo`.

Optional alerting:

```bash
ALERT_WEBHOOK_URL=https://hooks.example/... scripts/status-check.sh
```

The webhook payload is intentionally simple JSON so it works with Slack-compatible, Discord-compatible, or custom alert receivers.

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

Next production step:

- Add a real log/metrics sink (Better Stack, Grafana Cloud, Sentry, Honeycomb, etc.).
- Alert on: `/healthz` failure, DB errors, deploy failures, websocket error spikes, push delivery failure spikes, disk usage >80%, and Instant Server provision failure rate.

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
