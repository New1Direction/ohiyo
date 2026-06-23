# Contributing to Ohiyo

Thanks for wanting to help build Ohiyo. It's a free, self-hostable Discord
alternative with real end-to-end encryption, and it's better with more hands on
it. This guide gets you from a fresh clone to a green check.

Kikka the chinchilla approves of small, well-tested PRs. So do the maintainers.

## Before you start

- Read the [README](README.md) — the quickstart there is the source of truth for
  running the stack locally.
- For anything non-trivial, open an issue first so we can agree on the shape of
  the change before you spend time on it.
- Found a **security** issue? Don't open a public issue or PR. Follow
  [SECURITY.md](SECURITY.md) instead.

## Repo layout

```
server/   Rust axum + sqlx server (migrations/, src/, Dockerfile, fly.toml)
client/   React 19 + TypeScript + Vite app and the Tauri desktop shell (src/, src-tauri/)
e2e/      Node-driven end-to-end suites (NN-*.test.mjs + harness)
infra/    Optional infrastructure (coturn TURN server for WebRTC behind strict NATs)
brand/    Mascot + brand assets
```

## Dev setup

**Prerequisites:** Rust (stable) and Node 22+ (22.6+ is required for the client
unit tests, which use the built-in test runner with native TypeScript
type-stripping).

Follow the **Quickstart (local dev)** section of the [README](README.md):

1. Start the server (`cd server`, copy `.env.example` to `.env`, set a
   `JWT_SECRET`, then `cargo run` — migrations apply on startup). It listens on
   `http://localhost:3000`.
2. Start the client (`cd client`, `npm install`, `npm run dev`). Vite serves on
   `http://localhost:1420` and talks to the server on `:3000`.

Both have to be running for the end-to-end suite.

## Running the checks

CI runs exactly these. Run them locally before you push and you'll rarely be
surprised.

### Client (`client/`)

```bash
npm run lint        # ESLint — react-hooks and a11y rules are errors, not warnings
npm run typecheck   # tsc --noEmit
npm run test:unit   # node --test (needs Node 22.6+)
npm run build       # tsc && vite build — the production build must succeed
```

### End-to-end (`client/` or repo root)

The e2e suite drives a real Chromium against a fully running stack (server +
Vite client). Start both, then:

```bash
cd client
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e          # all 25 suites
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e receipts # filter by substring
```

The 25 suites cover signup, invites, moderation, roles, polls, mentions, events,
drafts, image uploads, receipts, the plugin sandbox, and the encrypted-DM /
group / multi-device / disappearing-message flows. A few of the crypto suites
are timing-sensitive, so e2e is run on demand and on a weekly schedule rather
than as a required pull-request check (yet) — but new behavior should still come
with coverage.

### Server (`server/`)

```bash
cargo fmt              # format your code (CI runs `cargo fmt --check`)
cargo clippy --all-targets --locked -- -D warnings
cargo build --locked
cargo test --locked
```

## CI is a hard gate

Every CI step is a blocking check — a regression can't merge. On the client:
**lint, typecheck, unit tests, and the production build** must pass. On the
server: **`cargo fmt --check`, `cargo clippy` with `-D warnings`, `cargo build`,
and `cargo test`** must all pass. If CI is red, the PR doesn't go in. Please get
it green before asking for review.

## Branch and PR flow

1. Fork (or branch, if you have push access). Branch off `main`.
2. Use a short, descriptive branch name, e.g. `fix/dm-receipt-race` or
   `feat/channel-pins`.
3. Make focused commits. Keep unrelated changes in separate PRs — small PRs get
   reviewed faster.
4. Run the full check list above and confirm it's green.
5. Open a PR against `main` with a clear description: what changed, why, and how
   you tested it. Link the issue it closes.
6. Address review feedback by pushing follow-up commits to the same branch.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/). Start the
subject with one of:

| Type       | Use for                                              |
|------------|------------------------------------------------------|
| `feat`     | a new feature                                        |
| `fix`      | a bug fix                                             |
| `docs`     | documentation only                                   |
| `refactor` | a code change that neither fixes a bug nor adds a feature |
| `test`     | adding or fixing tests                               |
| `chore`    | tooling, deps, config, and other housekeeping        |

Example:

```
feat: pin messages in channels

Adds a pin action to the message context menu and a pinned-messages
drawer. Server stores pins per-channel; gateway broadcasts pin/unpin.
```

## Changelog

We keep a [`CHANGELOG.md`](CHANGELOG.md) in the
[Keep a Changelog](https://keepachangelog.com/) format. If your change is user-facing or
security-relevant, add a one-line entry under the **`## [Unreleased]`** heading in the
right category — **Added**, **Changed**, **Fixed**, or **Security** — written for the
people running and using Ohiyo, not for reviewers. At release time a maintainer renames
`[Unreleased]` to the new version and tags it. Pure-internal refactors and test-only
changes don't need an entry.

## A friendly note

Be kind, assume good faith, and ask questions early — we'd much rather talk
through an approach with you than have you guess. By participating you agree to
our [Code of Conduct](CODE_OF_CONDUCT.md). Thanks for helping keep a free,
private chat app free and private.
