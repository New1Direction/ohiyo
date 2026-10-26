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

## Project-plan and skill review fixture

`project-review.test.mjs` is opt-in and skips in the ordinary chat E2E run. Never
enable it against a real provider. It tests the browser, authenticated HTTP,
SQLite, Pi Durable tools/journal and the real restricted validator subprocess;
only inference is scripted. Node 26+ is required for the sandbox success case.

Use a disposable local database and worker directory. Start
`node worker/test/fixtures/project-worker.mjs <worker-directory> school`; its
startup JSON prints the private worker port. Configure the server with:

- `DATABASE_URL=sqlite:<disposable-absolute-path>`
- `KIKKA_RUNTIME=pi`, `KIKKA_USER_ID=*`
- `KIKKA_WORKER_URL=http://127.0.0.1:<printed-port>/command`
- `KIKKA_WORKER_TOKEN=fixture-token-not-a-secret-000000000`
- `KIKKA_ROUTING_CONFIG=worker/test/fixtures/project-routing.json` (repository-root cwd)
- `KIKKA_SCHOOL_FIXTURE_KEY=fixture-not-a-real-provider-key`
- `OHIYO_REGISTER_LIMIT_PER_HOUR=0` on this disposable server only

The route is displayed and approved normally, but the fixture rejects network
inference and supplies scripted Pi responses. Do not use this fixture credential
or wildcard account scope outside isolated tests. Run the client with
`VITE_SERVER_URL=http://localhost:3000`, then:

```bash
KIKKA_PROJECT_FIXTURE=1 KIKKA_CHROMIUM=<chrome-path> node e2e/project-review.test.mjs
```

`KIKKA_API` can override the API root (default `http://localhost:3000/api/v1`);
it must equal the client's configured API root for the tab-scoped login.
In Amp orbs, run the fixture worker, API and Vite with supervised
`amp orb service start`, not detached shell processes. Screenshots go to
`KIKKA_SHOTS`; never use this fixture as evidence of live-model teaching quality.
