# Kikkacord

A free, self-hostable Discord alternative — servers, channels, DMs, and real-time
voice / video / screen-share, with a sandboxed plugin system and a brand of its own.
Rust on the backend, React 19 + Tauri on the desktop. No subscriptions, no paywalled
features, no telemetry.

> **Status:** v0.1.0 — early but real. 18 end-to-end suites green, live backend at
> [kikkacord.fly.dev](https://kikkacord.fly.dev). Desktop builds in
> [Releases](../../releases).

---

## Highlights

- **Text** — servers, channels, threads-of-thought, DMs, reactions, edits/deletes,
  attachments, **read receipts / delivered state** on DMs.
- **Voice & video** — WebRTC voice, video, and screen-share. STUN-only on LAN;
  optional coturn (`infra/coturn/`) for symmetric-NAT users.
- **Plugins** — arbitrary third-party plugins run in a **genuinely isolated Web
  Worker sandbox**: no network, no DOM, no token access, even via the prototype
  chain. See `client/src/plugins/`.
- **Design** — the **Daybreak** light theme (cream + coral, Quicksand + Inter) and a
  **Dusk** dark theme, with a real motion system and reduced-motion support.
- **Desktop-native** — Tauri app with native notifications and deep links; the web
  build runs anywhere.

## Tech stack

| Layer    | Tech |
|----------|------|
| Server   | Rust, [axum](https://github.com/tokio-rs/axum) 0.8, [sqlx](https://github.com/launchbadge/sqlx) + SQLite, WebSocket gateway |
| Client   | React 19, TypeScript, Tailwind CSS v4, Vite |
| Desktop  | Tauri 2 |
| Realtime | WebRTC (voice/video/screen-share), WS gateway with one-time tickets |
| Deploy   | Fly.io + Docker (see [`DEPLOY.md`](DEPLOY.md)) |
| Quality  | ESLint (hooks-as-error), `tsc`, `cargo test`, 18-suite e2e, GitHub Actions CI |

## Repo layout

```
server/        Rust axum + sqlx server (migrations/, src/, Dockerfile, fly.toml)
client/        React + Vite app and Tauri shell (src/, src-tauri/)
e2e/           Node-driven end-to-end suites (NN-*.test.mjs + harness)
infra/coturn/  Optional TURN server for WebRTC behind strict NATs
brand/         Mascot + brand assets (Daybreak)
DEPLOY.md      Production deploy guide (Fly.io)
UX-GATES.md    UX acceptance gates
kikkacord-guide.html   Standalone landing / feature guide
```

## Quickstart (local dev)

**Prerequisites:** Rust (stable) + Node 20+.

**1. Server** (`http://localhost:3000`)

```bash
cd server
cp .env.example .env          # set JWT_SECRET — `openssl rand -base64 48`
cargo run                     # migrations apply on startup
```

**2. Client** (Vite dev on `http://localhost:1420`, talks to `:3000`)

```bash
cd client
npm install
npm run dev
```

Open http://localhost:1420, register an account, create a space, and start talking.

## Desktop build

```bash
cd client
npm run tauri build           # produces the platform bundle (.dmg on macOS)
```

The packaged app connects to the backend in `client/.env.production`
(`VITE_SERVER_URL`, default `https://kikkacord.fly.dev`). Change it to your own Fly
app or self-hosted server.

## Testing

```bash
cd client
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e   # full suite
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e receipts   # filter by substring
npm run lint          # ESLint — react-hooks rules are errors
npm run typecheck     # tsc --noEmit
```

The server and Vite dev client must both be running for e2e. CI runs lint, typecheck,
client build, `cargo build`, and `cargo test` on every push.

## Deploy

Production runs on Fly.io. Full walkthrough — Docker image, volume-backed SQLite,
`fly secrets` for `JWT_SECRET`/TURN, and optional coturn — is in
[`DEPLOY.md`](DEPLOY.md).

## License

[AGPL-3.0](LICENSE). You're free to use, modify, self-host, and redistribute
Kikkacord. The one obligation: if you run a **modified** version as a network
service, you must offer your users its source. That's deliberate — it keeps every
hosted fork of a *free* chat app free.
