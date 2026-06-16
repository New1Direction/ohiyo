# Shipping Kikkacord to real people

Kikkacord has two halves. A desktop installer is worthless on its own — like
Discord, it needs a **server in the cloud** to connect to. This guide takes you
from "runs on my localhost" to "my friends download an app and it just works."

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Kikkacord.app / .msi   │  HTTPS  │  Fly.io                          │
│  (Tauri desktop client) │ ──────▶ │  • axum server  (Docker)         │
│  React bundle inside     │   WSS   │  • SQLite + uploads (volume)     │
│  a native window         │ ◀─────▶ │  • coturn (voice TURN, optional) │
└─────────────────────────┘         └──────────────────────────────────┘
```

- **Backend host:** Fly.io (chosen). Single machine + a persistent volume.
- **Signing:** unsigned installers for now; the seam for signing/auto-update is
  wired and documented in [§4](#4-code-signing--auto-update-the-later-path).

---

## 1. Deploy the backend to Fly.io

Everything here runs from `server/`.

```bash
cd server

# Install the Fly CLI once, then log in.
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login

# App names are GLOBALLY unique. Pick yours and set it as `app = "..."` in
# fly.toml (it ships as "kikkacord"). Create the app without deploying yet:
fly apps create kikkacord-<you>

# Create the persistent volume that fly.toml mounts at /data (DB + uploads).
# Keep it in the same region as primary_region in fly.toml (default: iad).
fly volumes create kikkacord_data --region iad --size 3   # 3 GB

# Required config — the server REFUSES to start in release without both.
#   JWT_SECRET       stable session-signing key (else every restart logs everyone out)
#   PUBLIC_BASE_URL  this app's public URL — it prefixes stored avatar/banner URLs,
#                    so a wrong/unset value bakes dead localhost links into the DB.
fly secrets set JWT_SECRET="$(openssl rand -base64 48)"
fly secrets set PUBLIC_BASE_URL="https://kikkacord-<you>.fly.dev"

# Ship it. fly.toml + Dockerfile do the rest.
fly deploy

# Verify.
curl https://kikkacord-<you>.fly.dev/healthz     # → ok
```

Notes baked into the config:

- **`Dockerfile`** is a multi-stage Rust build → a slim Debian runtime with just
  CA certs (sqlx bundles SQLite, reqwest uses rustls — no system libs needed).
- **`fly.toml`** keeps **one machine always running** (`auto_stop_machines = off`,
  `min_machines_running = 1`). A chat/voice server holds live WebSocket
  connections and presence — it must not sleep.
- **WebSockets** (`/gateway`) work over Fly's HTTP service automatically.
- The volume at `/data` holds both `kikkacord.db` and the `uploads/` directory,
  so messages and files survive deploys and restarts.

> **Scaling caveat:** SQLite on a local volume means exactly **one** machine — do
> not `fly scale count 2`. When you outgrow a single node, migrate to
> [LiteFS](https://fly.io/docs/litefs/) (SQLite replication) or Postgres.

---

## 2. Voice (TURN) — for calls across the internet

STUN alone works on a LAN. Real calls between people behind home routers need a
**TURN relay**. The coturn config already lives in `infra/coturn/`.

1. Run coturn on a public host (a small VPS, or a second Fly app) using
   `infra/coturn/docker-compose.yml`. Set its `static-auth-secret`.
2. Point the Kikkacord server at it with secrets matching that value:

```bash
cd server
fly secrets set \
  TURN_SECRET="<same as coturn static-auth-secret>" \
  TURN_URLS="turn:turn.kikkacord-<you>.com:3478?transport=udp" \
  TURN_TTL=86400
```

The server mints short-lived TURN credentials at `GET /api/v1/ice-servers`; the
client fetches them before each call.

---

## 3. Build the desktop app

Everything here runs from `client/`.

```bash
cd client

# Point the packaged app at YOUR backend (this is baked in at build time).
# Edit client/.env.production:
#   VITE_SERVER_URL=https://kikkacord-<you>.fly.dev

npm install
npm run tauri build
```

Installers land in `client/src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| macOS    | `dmg/Kikkacord_<ver>_aarch64.dmg` and `macos/Kikkacord.app` |
| Windows  | `msi/Kikkacord_<ver>_x64_en-US.msi`, `nsis/...-setup.exe`   |
| Linux    | `appimage/Kikkacord_<ver>_amd64.AppImage`, `deb/`, `rpm/`   |

> You can only build a platform's installer **on that platform** (or in CI). On
> your Mac you get the `.dmg`; use GitHub Actions runners for Windows/Linux —
> see [§5](#5-recommended-cicd).

### What's already native (Discord-like)

- **Brand icon & window** — coral bird icon, "Kikkacord" titled 1180×760 window
  with a sensible minimum size, generated from `src-tauri/app-icon.svg`.
- **Single instance** — launching again focuses the running window instead of
  opening a second one.
- **Deep links** — `kikkacord://invite/<code>` opens the app straight to the
  join screen (the client falls back to `?invite=<code>` web links in a browser).
  On macOS the scheme is registered via the bundle; on Linux/Windows the
  installer registers it.
- **Native OS notifications** — under Tauri, new-message pings use the system
  notification center; in a browser they fall back to Web Notifications.
- **Hardened CSP** — `object-src 'none'`, `base-uri 'self'`, `frame-ancestors
  'none'`, scoped `connect-src`/`img-src`. See the follow-ups below.

---

## 4. Code signing & auto-update (the "later" path)

Installers build **unsigned** today, so first-launch shows a one-time OS warning
(macOS Gatekeeper / Windows SmartScreen). When you're ready for a public launch:

### macOS notarization
1. Join the Apple Developer Program ($99/yr), create a **Developer ID
   Application** certificate.
2. Set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
   `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` in the build env.
3. `npm run tauri build` signs + notarizes automatically.

### Windows signing
Obtain a code-signing certificate (OV/EV) and set the `tauri.conf.json`
`bundle.windows.certificateThumbprint` (or use Azure Trusted Signing).

### Auto-update (silent, Discord-style)
1. Generate the updater keypair (this is separate from code-signing certs):
   ```bash
   npm run tauri signer generate -- -w ~/.kikkacord/updater.key
   ```
   Keep the **private** key secret; the **public** key goes in config.
2. Add to `tauri.conf.json`:
   ```jsonc
   "plugins": {
     "updater": {
       "pubkey": "<public key>",
       "endpoints": ["https://github.com/<you>/kikkacord/releases/latest/download/latest.json"]
     }
   }
   ```
   and add `tauri-plugin-updater = "2"` (Cargo) + `.plugin(tauri_plugin_updater::Builder::new().build())`
   (lib.rs) + `"updater:default"` (capabilities).
3. Each release, upload the signed bundles + `latest.json`. The app checks on
   launch and updates in the background.

---

## 5. Recommended CI/CD

Use [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) in
GitHub Actions with a `macos-latest` + `windows-latest` + `ubuntu-latest` matrix
to build all three installers on every tag, attach them to a GitHub Release, and
(once signing is set up) publish the `latest.json` the updater reads.

---

## 6. Pre-launch hardening checklist

These are tracked follow-ups, not blockers for a first test build:

- [ ] **Plugin sandbox.** The CSP now blocks remote-URL plugin scripts (they were
      executing arbitrary JS in the app's context). Built-in plugins still work.
      Before re-enabling remote plugins, sandbox them in an iframe/Worker.
- [ ] **Tighten CSP `connect-src`** from `https: wss:` to your exact backend host
      once it's fixed (`https://kikkacord-<you>.fly.dev wss://...`).
- [ ] **Token storage.** The web client keeps the session token in
      `localStorage`. Acceptable in the packaged app; revisit if you ship a pure
      web build to untrusted origins.
- [ ] **Proxy IPs.** Behind Fly, parse `X-Forwarded-For` so auth rate-limiting
      keys on the real client IP, not the proxy.
- [ ] **Privacy policy + Terms of Service.** Required by app stores and by users
      before they trust a social app with their chats.
- [ ] **Load test** to replace the dev-machine benchmark numbers on the
      comparison page with production figures.
