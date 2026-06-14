# Kikkacord E2E suite

Browser-driven end-to-end tests covering the critical user journeys. Each file
drives one or more real Chromium contexts via `playwright-core` and asserts the
full client↔server↔gateway round trip.

## Suites

| File | Covers |
|------|--------|
| `01-signup.test.mjs` | Register → onboarding → create space → land in channel → send · login + remembered username + friendly error · password show/hide · responsive auth · mobile drawer |
| `02-invite.test.mjs` | Invite link → open logged-out → register → accept → join · live message delivery · find-people → DM |
| `03-alive.test.mjs` | Typing indicators · replies (+ quote both sides) · unread badges · custom status (+ persist across reload) |
| `04-actions.test.mjs` | Edit (+ "(edited)") · pin/unpin · delete (inline confirm) · tab-title unread badge |
| `05-moderation.test.mjs` | Message search + jump-to-channel · members panel · owner kick (member dropped live) |

## Prerequisites

1. **Server** running on `:3000` — `cd server && cargo run`
2. **Vite dev** running on `:5173` — `cd client && npm run dev`
3. **Chromium** available — `cd client && npx playwright install chromium`
   (the harness auto-locates the cached "Chrome for Testing" binary)

## Run

```bash
# all suites
node e2e/run.mjs
# or via the client package script
cd client && npm run test:e2e

# a single suite (substring filter)
node e2e/run.mjs invite
```

## Config (env overrides)

| Var | Default | Purpose |
|-----|---------|---------|
| `KIKKA_ORIGIN` | `http://localhost:5173` | client URL under test |
| `KIKKA_CHROMIUM` | auto-detected | path to a Chromium/Chrome binary |
| `KIKKA_SHOTS` | `/tmp/kikka-shots` | screenshot output dir |

Tests create throwaway accounts with unique suffixes, so they're safe to re-run
against a dev database. For CI, point `KIKKA_ORIGIN` at a freshly-seeded preview.
