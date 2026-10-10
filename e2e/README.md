# Ohiyo E2E suite

Browser-driven end-to-end tests covering the critical user journeys. Each file
drives one or more real Chromium contexts via `playwright-core` and asserts the
full client↔server↔gateway round trip.

## Suites

Each `NN-*.test.mjs` file is one journey; the filename names it. See the directory
for all 28.

## Prerequisites

1. **Server** running on `:3000` — `cd server && cargo run`, with
   `OHIYO_REGISTER_LIMIT_PER_HOUR=0` in `server/.env` (the suites register about 40
   accounts from one address, and the default limit is 10 per hour)
2. **Client** running on `:1420` — either `cd client && bun run dev` or `bun run build && bun run preview -- --port 1420`
3. **Chromium** available — `cd client && bunx playwright-core install chromium`
   (the harness auto-locates the cached "Chrome for Testing" binary)

## Hosted coverage

`.github/workflows/e2e.yml` runs the full suite on GitHub-hosted Ubuntu for pull
requests, pushes to `main`, manual dispatch, and the weekly schedule. It runs a
matrix against both:

- `dev`: Vite dev server, for fast local-equivalent feedback.
- `production-preview`: built client served by Vite preview, which catches CSP,
  asset, and build-only regressions that the dev server can mask.

On failure the job uploads `KIKKA_SHOTS` plus server/client logs as artifacts.

## Run

```bash
# all suites
node e2e/run.mjs
# or via the client package script
cd client && bun run test:e2e

# a single suite (substring filter)
node e2e/run.mjs invite
```

## Config (env overrides)

| Var | Default | Purpose |
|-----|---------|---------|
| `KIKKA_ORIGIN` | `http://localhost:1420` | client URL under test |
| `KIKKA_CHROMIUM` | auto-detected | path to a Chromium/Chrome binary |
| `KIKKA_SHOTS` | `/tmp/kikka-shots` | screenshot output dir |

Tests create throwaway accounts with unique suffixes, so they're safe to re-run
against a dev database. For CI, point `KIKKA_ORIGIN` at a freshly-seeded preview.
