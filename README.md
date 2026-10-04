# Ohiyo

[![Builder fees earned on repo.ing](https://repo.ing/api/badge/1269625283)](https://repo.ing/token/9RnMkXRLtkpMSWSCfgbUoGsYmJovAgEgJ7z8sHnwbaHk)

A private-by-design chat app with Discord-like ease — servers, channels, DMs, and
real-time voice / video / screen-share, with **end-to-end encryption you can turn on
for DMs and group chats**, a sandboxed plugin system, and a brand of its own. Rust on the backend, React 19 + Tauri
on the desktop. No subscriptions, no paywalled features, no telemetry. And **launch
your own server in one tap** — Realms-style hosting with export ownership and
self-host always one click away. Encrypted DMs and group chats stay ciphertext on the
box; server channels are stored like any chat server's.

<p align="center">
  <img src="./brand/preview-cream.png" alt="Ohiyo on the Daybreak light theme — cream and coral, with channels, chat, and member list" width="48%" />
  <img src="./brand/preview-dark.png" alt="Ohiyo on the Dusk dark theme — the same client in dark mode" width="48%" />
</p>

<p align="center">
  <img src="./brand/kikka-chinchilla.svg" alt="Kikka, the coral chinchilla mascot" width="120" />
</p>

> **Status:** v0.2.0 public beta — early but real. The hosted app is live at
> [app.ohiyo.gg](https://app.ohiyo.gg), the public site is live at
> [ohiyo.gg](https://ohiyo.gg), and a 28-suite end-to-end run is part of CI. Desktop builds are in
> [Releases](../../releases); Mac builds are beta/ad-hoc signed until Apple notarization is complete.

---

## Highlights

- **End-to-end encryption, per conversation** — turn on the lock in a DM or group chat
  and messages are encrypted on your device with the
  [Signal Protocol](https://signal.org/docs/) before they leave it; for those messages
  the server relays only **ciphertext**. It is **opt-in today, not the default**, and
  server channels are not end-to-end encrypted. Multi-device, with disappearing
  messages, safety numbers, padded plaintext, encrypted attachments, and Privacy Mode
  for quieter metadata. Encrypted messages show no link previews and cannot be
  forwarded, so their content stays off the server. **Group encryption is
  experimental** and can miss messages sent while you were offline. Ohiyo is not
  anonymous or SimpleX-level metadata privacy; it keeps Discord-like convenience while
  reducing avoidable leaks. See
  [Known limits of the encryption](#known-limits-of-the-encryption) below. *(e2e
  suites `19-e2e-dm`, `20-disappearing`, `21-multidevice`, `22-group-e2e`,
  `26-privacy-mode`, `27-private-dm-links`.)*
- **Instant Servers** — launch your own community server in **one tap**. We host it
  (Minecraft-Realms-style): encrypted DMs and group chats are ciphertext on the box,
  while server channels are stored in the clear like any chat server's. Export anytime,
  or graduate to your own box, or self-host for **$0**; all for less than one Discord
  Nitro. *(Phase 1 shipped — control plane + provisioning; design + plan in
  [`docs/superpowers/`](docs/superpowers/).)*
- **One-command Discord template migration** — give Ohiyo a Discord Server Template
  link and it reconstructs categories, channels, roles, best-effort permission bits,
  overwrite snapshots, server icon, and custom emoji assets. See
  [`docs/discord-template-migration.md`](docs/discord-template-migration.md).
- **Text** — servers, channels, threads-of-thought, DMs, reactions, edits/deletes,
  attachments, **read receipts / delivered state** on DMs.
- **Voice & video** — WebRTC voice, video, and screen-share, with Discord-like live
  voice rows, a pre-join roster, and a “Ready to join?” preview with Join muted, so you
  can see who is already in a room before hopping in. Voice participation is honest:
  joining reveals you to the room/channel audience even when media is encrypted.
  Peer-to-peer with STUN on LAN; optional coturn (`infra/coturn/`) for symmetric-NAT users, or an optional LiveKit SFU
  (`infra/livekit/`) for larger rooms.
- **Plugins** — third-party plugins run in a **Web Worker sandbox** with no DOM and no
  token access. Network APIs are removed inside the worker and the web build's CSP
  limits what remains; on desktop the sandbox is the only barrier, so install only
  plugins you trust. See `client/src/plugins/`.
- **Design** — the **Daybreak** light theme (cream + coral, Quicksand + Inter) and a
  **Dusk** dark theme, with a real motion system and reduced-motion support.
- **Desktop-native** — Tauri app with native notifications, deep links, and an
  encrypted local vault for sensitive cache namespaces; the web build runs anywhere.
- **Fast private actions** — Ctrl/⌘K jumps to channels and also exposes quick actions
  for Privacy Mode, one-time private DM links, and joining an active voice room.

## Tech stack

| Layer    | Tech |
|----------|------|
| Server   | Rust, [axum](https://github.com/tokio-rs/axum) 0.8, [sqlx](https://github.com/launchbadge/sqlx) + SQLite, WebSocket gateway |
| Client   | React 19, TypeScript, Tailwind CSS v4, Vite |
| Desktop  | Tauri 2 |
| Realtime | WebRTC (voice/video/screen-share), WS gateway with one-time tickets |
| Deploy   | Docker on Railway or Fly.io (see [`DEPLOY.md`](DEPLOY.md)) |
| Quality  | ESLint (hooks-as-error), `tsc`, unit tests, `cargo test`, 28-suite e2e, GitHub Actions CI |

## Repo layout

```
server/        Rust axum + sqlx server (migrations/, src/, Dockerfile, fly.toml)
client/        React + Vite app and Tauri shell (src/, src-tauri/)
e2e/           Node-driven end-to-end suites (NN-*.test.mjs + harness)
infra/coturn/  Optional TURN server for WebRTC behind strict NATs
brand/         Mascot (Kikka) + brand assets (Daybreak)
site/          Public landing page (deploys to ohiyo.gg)
docs/          Design specs & plans
CHANGELOG.md   Release notes (Keep a Changelog)
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
(`VITE_SERVER_URL`, e.g. `https://ohiyo-server-production.up.railway.app` or your own server). The public beta
uses the hosted Ohiyo backend; you can also point the app at **your own** Fly app,
self-hosted server, or custom home. See [`DEPLOY.md`](DEPLOY.md) to stand one up.

## Testing

```bash
cd client
npm run test:unit     # unit tests (Node 22.6+)
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e   # full suite (27)
KIKKA_ORIGIN=http://localhost:1420 npm run test:e2e receipts   # filter by substring
npm run lint          # ESLint — react-hooks rules are errors
npm run typecheck     # tsc --noEmit
```

The server and Vite dev client (port 1420) must both be running for e2e. On every
push, CI runs the full gate: **ESLint**, **`tsc`**, **unit tests** (`test:unit`),
**client build**, **`cargo fmt --check`**, **`cargo clippy -D warnings`**,
**`cargo build`**, and **`cargo test`**.

## Deploy

The hosted service runs on Railway: the server from `server/Dockerfile` and the browser
app from `client/Dockerfile`. The landing site is published to GitHub Pages. The full
walkthrough — Docker image, volume-backed SQLite, secrets for `JWT_SECRET`/TURN,
optional coturn, and the Fly.io and Railway specifics — is in [`DEPLOY.md`](DEPLOY.md).

## Public privacy docs

Ohiyo's privacy boundary is documented publicly:

- [Privacy Policy](https://ohiyo.gg/privacy.html)
- [Privacy Threat Model](https://ohiyo.gg/threat-model.html) — what E2EE protects,
  what metadata remains, and when to choose self-hosting, custom homes, or Tor Browser
  with an onion home.

### Known limits of the encryption

We would rather you know these than find them:

- **Opt-in.** A conversation is encrypted only after someone turns on the lock. New
  DMs start unencrypted.
- **New devices are trusted on first use.** When a contact (or your own account) adds
  a device, your client starts encrypting to it without a prompt. A malicious server,
  or someone holding a stolen session, could add a device and read messages sent after
  that. Compare safety numbers out of band for conversations that matter.
- **Group encryption is experimental.** It is Ohiyo's own sender-key design, not
  Signal's, and it can miss messages sent while a member was offline.
- **Not end-to-end encrypted:** server channels, polls, and watch-party links.
- **Signing out removes readable history from that device.** An encrypted message can
  be decrypted only once, so the app keeps a readable copy on the device. Signing out
  of your last account there removes those copies (after a confirmation), and they
  cannot be decrypted on that device again. Your other devices are not affected.
- **One account per browser profile.** Encryption keys are stored per browser profile,
  not per account. Signing in to a second account in the same profile reuses the first
  account's keys and breaks its sessions; use a separate profile for each account.
- **No external audit yet.** One-to-one chat uses a community TypeScript port of the
  Signal Protocol; the group scheme, voice keys, backup and desktop vault are our own
  constructions.

Closing the first three is on the [roadmap](ROADMAP.md).

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
