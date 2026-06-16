# Ohiyo

A free, self-hostable Discord alternative — servers, channels, DMs, and real-time
voice / video / screen-share, with **end-to-end encryption**, a sandboxed plugin
system, and a brand of its own. Rust on the backend, React 19 + Tauri on the desktop.
No subscriptions, no paywalled features, no telemetry. And **launch your own encrypted
server in one tap** — Realms-style hosting where the box only ever holds ciphertext,
with export and self-host always one click away.

<p align="center">
  <img src="./brand/preview-cream.png" alt="Ohiyo on the Daybreak light theme — cream and coral, with channels, chat, and member list" width="48%" />
  <img src="./brand/preview-dark.png" alt="Ohiyo on the Dusk dark theme — the same client in dark mode" width="48%" />
</p>

<p align="center">
  <img src="./brand/kikka-chinchilla.svg" alt="Kikka, the coral chinchilla mascot" width="120" />
</p>

> **Status:** v0.1.0 — early but real. 22 end-to-end suites green. There's no public
> backend yet — you self-host your own (it's one command). Desktop builds in
> [Releases](../../releases).

---

## Highlights

- **End-to-end encryption** — DMs **and** group chats are encrypted with the
  [Signal Protocol](https://signal.org/docs/). Keys live on your devices; the server
  only ever relays **ciphertext** and never sees your messages. Multi-device, with
  disappearing messages and safety-number verification. *(See e2e suites
  `19-e2e-dm`, `20-disappearing`, `21-multidevice`, `22-group-e2e`.)*
- **Instant Servers** — launch your own end-to-end-encrypted community server in **one
  tap**. We host it (Minecraft-Realms-style) but the box only ever holds ciphertext —
  export anytime, or graduate to your own box, or self-host for **$0**; all for less than
  one Discord Nitro. *(Phase 1 shipped — control plane + provisioning; design + plan in
  [`docs/superpowers/`](docs/superpowers/).)*
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
| Quality  | ESLint (hooks-as-error), `tsc`, unit tests, `cargo test`, 22-suite e2e, GitHub Actions CI |

## Repo layout

```
server/        Rust axum + sqlx server (migrations/, src/, Dockerfile, fly.toml)
client/        React + Vite app and Tauri shell (src/, src-tauri/)
e2e/           Node-driven end-to-end suites (NN-*.test.mjs + harness)
infra/coturn/  Optional TURN server for WebRTC behind strict NATs
brand/         Mascot (Kikka) + brand assets (Daybreak)
site/          Public landing page (deploys to ohiyo.gg)
docs/          Design specs & plans
DEPLOY.md      Production deploy guide (Fly.io)
UX-GATES.md    UX acceptance gates
```

## Quickstart (local dev)

**Prerequisites:** Rust (stable) + Node 22+ (22.6+ for unit tests).

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
(`VITE_SERVER_URL`, e.g. `https://your-server.fly.dev`). There's no shared public
backend — point this at **your own** Fly app or self-hosted server. See
[`DEPLOY.md`](DEPLOY.md) to stand one up.

## Testing

```bash
cd client
npm run test:unit     # unit tests (Node 22.6+)
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e   # full suite (22)
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e receipts   # filter by substring
npm run lint          # ESLint — react-hooks rules are errors
npm run typecheck     # tsc --noEmit
```

The server and Vite dev client (port 1420) must both be running for e2e. On every
push, CI runs the full gate: **ESLint**, **`tsc`**, **unit tests** (`test:unit`),
**client build**, **`cargo fmt --check`**, **`cargo clippy -D warnings`**,
**`cargo build`**, and **`cargo test`**.

## Deploy

Production runs on Fly.io. Full walkthrough — Docker image, volume-backed SQLite,
`fly secrets` for `JWT_SECRET`/TURN, and optional coturn — is in
[`DEPLOY.md`](DEPLOY.md).

## License

[AGPL-3.0](LICENSE). You're free to use, modify, self-host, and redistribute
Ohiyo. The one obligation: if you run a **modified** version as a network
service, you must offer your users its source. That's deliberate — it keeps every
hosted fork of a *free* chat app free.

---

<p align="center">
  <a href="https://ohiyo.gg">ohiyo.gg</a> ·
  <a href="https://github.com/New1Direction/ohiyo">github.com/New1Direction/ohiyo</a> ·
  <a href="../../releases">Releases</a>
  <br />
  <sub>Made with care (and one coral chinchilla named Kikka).</sub>
</p>
