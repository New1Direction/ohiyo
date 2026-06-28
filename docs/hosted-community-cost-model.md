# Hosted Community Cost Model

Ohiyo's Instant Servers pricing target is simple: free servers can sleep; paid servers stay always-on for less than one Discord Nitro for the whole community.

Live model endpoint:

```text
GET /api/v1/reliability/cost-model?communities=100&paid=20&free_active_ratio=0.15
```

## Public assumptions in the beta model

| Line item | Assumption |
|---|---:|
| Shared control plane | $12/mo |
| Shared push/status relay | $5/mo |
| Paid always-on instance | $3.80/mo per paid community |
| Free sleeping instance | $0.65 × active duty-cycle per free community |
| Storage + backups | $0.18/mo per community |
| Observability + alerts | $0.08/mo per community |
| Paid tier revenue | $8/mo per paid community |

These are planning numbers, not invoices. The real model should be updated from Fly, Cloudflare, storage, email/push, and observability bills.

## Why this matters

- Free tier must be cost-honest, not a trap.
- Paid tier must fund always-on managed servers.
- Self-host remains the free forever floor.
- Export/graduate must stay available so hosted pricing never becomes lock-in.

## Example

100 communities, 20 paid, 80 free, free duty-cycle 15%:

```bash
curl 'https://ohiyo.fly.dev/api/v1/reliability/cost-model?communities=100&paid=20&free_active_ratio=0.15' | jq
```

Interpretation:

- If gross margin is negative, either the paid conversion is too low, the price is too low, or the free sleep/duty-cycle/storage assumptions are wrong.
- If gross margin is positive, keep the surplus for support, abuse handling, backups, audits, and runway.
