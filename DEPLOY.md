# Shipping Ohiyo to real people

Ohiyo has two halves. A desktop installer is worthless on its own — like
Discord, it needs a **server in the cloud** to connect to. This guide takes you
from "runs on my localhost" to "my friends download an app and it just works."

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Ohiyo.app / .msi   │  HTTPS  │  Fly.io                          │
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
# fly.toml (it ships as "ohiyo"). Create the app without deploying yet:
fly apps create ohiyo-<you>

# Create the persistent volume that fly.toml mounts at /data (DB + uploads).
# Keep it in the same region as primary_region in fly.toml (default: iad).
fly volumes create ohiyo_data --region iad --size 3   # 3 GB

# Required config — the server REFUSES to start in release without both.
#   JWT_SECRET       stable session-signing key (else every restart logs everyone out)
#   PUBLIC_BASE_URL  this app's public URL — it prefixes stored avatar/banner URLs,
#                    so a wrong/unset value bakes dead localhost links into the DB.
fly secrets set JWT_SECRET="$(openssl rand -base64 48)"
fly secrets set PUBLIC_BASE_URL="https://ohiyo-<you>.fly.dev"

# Ship it. fly.toml + Dockerfile do the rest.
fly deploy

# Verify.
curl https://ohiyo-<you>.fly.dev/healthz     # → ok
```

Notes baked into the config:

- **`Dockerfile`** is a multi-stage Rust build → a slim Debian runtime with just
  CA certs (sqlx bundles SQLite, reqwest uses rustls — no system libs needed).
- **`fly.toml`** keeps **one machine always running** (`auto_stop_machines = off`,
  `min_machines_running = 1`). A chat/voice server holds live WebSocket
  connections and presence — it must not sleep.
- **WebSockets** (`/gateway`) work over Fly's HTTP service automatically.
- The volume at `/data` holds both `ohiyo.db` and the `uploads/` directory,
  so messages and files survive deploys and restarts.

> **Scaling caveat:** SQLite on a local volume means exactly **one** machine — do
> not `fly scale count 2`. When you outgrow a single node, migrate to
> [LiteFS](https://fly.io/docs/litefs/) (SQLite replication) or Postgres.

### Backups — set this up before you have real users

The `/data` volume holds the SQLite DB: **all** message ciphertext *and* the
encrypted `key_backups` blobs. Losing it is unrecoverable, so back it up.

- **Fly volume snapshots (baseline, automatic).** Fly snapshots every volume
  daily and keeps them ~5 days by default. Extend retention and *practice a
  restore* before you need one:
  ```bash
  fly volumes snapshots list <volume-id>
  fly volumes update <volume-id> --snapshot-retention 30
  # restore into a fresh volume:
  fly volumes create ohiyo_data --snapshot-id <snap> --region iad
  ```
- **Continuous backup (recommended — already wired in).** The runtime image bundles
  [Litestream](https://litestream.io). Set `LITESTREAM_REPLICA_URL` (+ store
  credentials) and the SQLite WAL streams to object storage (S3/R2) for point-in-time
  recovery, and the DB is auto-restored on a fresh volume. Setup:
  [`infra/litestream/README.md`](infra/litestream/README.md). Unset = off (no-op).

> A daily snapshot can lose up to 24h of messages; Litestream closes that gap.

---

## 2. Voice (TURN) — for calls across the internet

STUN alone works on a LAN. Real calls between people behind home routers need a
**TURN relay**. The coturn config already lives in `infra/coturn/`.

1. Run coturn on a public host (a small VPS, or a second Fly app) using
   `infra/coturn/docker-compose.yml`. Set its `static-auth-secret`.
2. Point the Ohiyo server at it with secrets matching that value:

```bash
cd server
fly secrets set \
  TURN_SECRET="<same as coturn static-auth-secret>" \
  TURN_URLS="turn:turn.ohiyo-<you>.com:3478?transport=udp" \
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
#   VITE_SERVER_URL=https://ohiyo-<you>.fly.dev

npm install
npm run tauri build
```

Installers land in `client/src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| macOS    | `dmg/Ohiyo_<ver>_aarch64.dmg` and `macos/Ohiyo.app` |
| Windows  | `msi/Ohiyo_<ver>_x64_en-US.msi`, `nsis/...-setup.exe`   |
| Linux    | `appimage/Ohiyo_<ver>_amd64.AppImage`, `deb/`, `rpm/`   |

> You can only build a platform's installer **on that platform** (or in CI). On
> your Mac you get the `.dmg`; use GitHub Actions runners for Windows/Linux —
> see [§5](#5-recommended-cicd).

### What's already native (Discord-like)

- **Brand icon & window** — coral Kikka (chinchilla) icon, "Ohiyo" titled 1180×760 window
  with a sensible minimum size, generated from `src-tauri/app-icon.svg`.
- **Single instance** — launching again focuses the running window instead of
  opening a second one.
- **Deep links** — `ohiyo://invite/<code>` opens the app straight to the
  join screen (the client falls back to `?invite=<code>` web links in a browser).
  On macOS the scheme is registered via the bundle; on Linux/Windows the
  installer registers it.
- **Native OS notifications** — under Tauri, new-message pings use the system
  notification center; in a browser they fall back to Web Notifications.
- **Hardened CSP** — `object-src 'none'`, `base-uri 'self'`, `frame-ancestors
  'none'`, scoped `connect-src`/`img-src`. See the follow-ups below.

---

## 4. Discord import live proof

Before showing Discord import to customers, follow the beginner checklist in
[`docs/discord-import-live-smoke-test.md`](docs/discord-import-live-smoke-test.md).

The customer-facing app flow must stay simple: **Add Ohiyo to Discord → Find my
servers → Pick server → Clone selected server**. Keep all bot tokens and Discrawl
paths private on the server/deployment only.

---

## 5. Code signing & auto-update (the "later" path)

Installers can build with **ad-hoc macOS signing** for private QA when Apple
Developer ID secrets are missing. That keeps downloaded `.dmg` files structurally
valid and avoids the worst "app is damaged" failure, but normal users will still
see Apple's scary "could not verify Ohiyo is free of malware" Gatekeeper warning.

Public `v*` tag releases now refuse to build macOS assets unless Developer ID
signing + notarization secrets are present. Use the ad-hoc fallback only through
manual `workflow_dispatch` for private QA. For customer downloads, use official
signing:

### macOS notarization
1. Join the Apple Developer Program ($99/yr), create a **Developer ID
   Application** certificate.
2. Set all six GitHub Actions secrets:
   - `APPLE_CERTIFICATE` — base64 `.p12` Developer ID Application certificate
   - `APPLE_CERTIFICATE_PASSWORD` — password for that `.p12`
   - `APPLE_SIGNING_IDENTITY` — exact Developer ID identity name
   - `APPLE_ID` — Apple ID email
   - `APPLE_PASSWORD` — app-specific password
   - `APPLE_TEAM_ID` — Apple Developer Team ID
3. Push a `v*` tag or run the Release workflow manually. CI switches to Developer
   ID signing + notarization automatically when all six secrets are present.
4. Before publishing the GitHub Release or re-enabling Mac download buttons on the
   website, download the `.dmg` on a clean Mac and confirm it opens without the
   "Apple could not verify" warning.

### Windows signing
Obtain a code-signing certificate (OV/EV) and set the `tauri.conf.json`
`bundle.windows.certificateThumbprint` (or use Azure Trusted Signing).

### Auto-update (silent, Discord-style)
1. Generate the updater keypair (this is separate from code-signing certs):
   ```bash
   npm run tauri signer generate -- -w ~/.ohiyo/updater.key
   ```
   Keep the **private** key secret; the **public** key goes in config.
2. Add to `tauri.conf.json`:
   ```jsonc
   "plugins": {
     "updater": {
       "pubkey": "<public key>",
       "endpoints": ["https://github.com/<you>/ohiyo/releases/latest/download/latest.json"]
     }
   }
   ```
   and add `tauri-plugin-updater = "2"` (Cargo) + `.plugin(tauri_plugin_updater::Builder::new().build())`
   (lib.rs) + `"updater:default"` (capabilities).
3. Each release, upload the signed bundles + `latest.json`. The app checks on
   launch and updates in the background.

---

## 6. CI/CD

`.github/workflows/release.yml` builds the macOS (Apple Silicon + Intel) and Linux
installers on every `v*` tag (or via manual dispatch) and attaches them to a
**draft** GitHub Release. macOS has two explicit CI paths: Developer ID signed +
notarized when all Apple secrets are present, otherwise ad-hoc signed fallback:

| Secret | Purpose |
|--------|---------|
| `VITE_SERVER_URL` | Backend URL baked into the bundle (`https://<app>.fly.dev`) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS Developer ID signing + notarization (§4) |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri auto-updater signing (§4) |

Cut a release with `git tag v0.1.1 && git push --tags`. The end-to-end suite runs
separately (`.github/workflows/e2e.yml`, manual + weekly) — it is not yet a merge
gate (a couple of crypto suites are timing-sensitive; stabilise on a runner first).

---

## 7. Pre-launch hardening checklist

These are tracked follow-ups, not blockers for a first test build:

- [ ] **Plugin sandbox.** The CSP now blocks remote-URL plugin scripts (they were
      executing arbitrary JS in the app's context). Built-in plugins still work.
      Before re-enabling remote plugins, sandbox them in an iframe/Worker.
- [ ] **Tighten CSP `connect-src`** from `https: wss:` to your exact backend host
      once it's fixed (`https://ohiyo-<you>.fly.dev wss://...`).
- [ ] **Token storage.** The web client keeps the session token in
      `localStorage`. Acceptable in the packaged app; revisit if you ship a pure
      web build to untrusted origins.
- [ ] **Proxy IPs.** Behind Fly, parse `X-Forwarded-For` so auth rate-limiting
      keys on the real client IP, not the proxy.
- [ ] **Privacy policy + Terms of Service.** Required by app stores and by users
      before they trust a social app with their chats.
- [ ] **Load test** to replace the dev-machine benchmark numbers on the
      comparison page with production figures.
