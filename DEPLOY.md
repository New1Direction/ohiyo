# Shipping Ohiyo to real people

Ohiyo has two halves. A desktop installer is worthless on its own — like
Discord, it needs a **server in the cloud** to connect to. This guide takes you
from "runs on my localhost" to "my friends download an app and it just works."

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Ohiyo.app / .msi   │  HTTPS  │  Railway or Fly.io               │
│  (Tauri desktop client) │ ──────▶ │  • axum server  (Docker)         │
│  React bundle inside     │   WSS   │  • SQLite + uploads (volume)     │
│  a native window         │ ◀─────▶ │  • coturn (voice TURN, optional) │
└─────────────────────────┘         └──────────────────────────────────┘
```

- **Backend host:** any host that runs a Docker image with one persistent volume.
  ohiyo.gg runs on Railway ([§1](#1-deploy-the-backend)); the repo also ships a
  `fly.toml` for Fly.io. Either way it is a single machine with a persistent volume.
- **Signing:** Mac installers are ad-hoc signed for now (not Apple-notarized); see
  [§5](#5-code-signing--auto-update-the-later-path). Auto-update is on and has its own key.

---

## 1. Deploy the backend

Ohiyo needs exactly **one** running server and **one** persistent volume mounted at
`/data` (the SQLite database and uploads). Any host that runs a Docker image with a
volume works; both paths below build `server/Dockerfile`.

### Railway (what ohiyo.gg runs on)

From the repo root, with the Railway CLI logged in. Create a project, a service for the
server and a volume mounted at `/data` (`railway volume add`, or the dashboard), then:

```bash
# Required: the server REFUSES to start in release without JWT_SECRET and PUBLIC_BASE_URL.
railway variable set --service ohiyo-server \
  JWT_SECRET="$(openssl rand -base64 48)" \
  PUBLIC_BASE_URL="https://<your-service>.up.railway.app" \
  OHIYO_OPERATOR_USER_IDS="<your-user-id>" \
  RAILWAY_RUN_UID=0 PORT=3000 BIND_ADDR=0.0.0.0:3000 TRUSTED_PROXY_HOPS=2

# Build server/Dockerfile on Railway and wait for the health check (/healthz).
railway up server --path-as-root --service ohiyo-server --ci

curl https://<your-service>.up.railway.app/healthz     # -> ok
```

`OHIYO_OPERATOR_USER_IDS` is a comma-separated list of user ids. Only those accounts can
run Discord imports or change an Instant Server's tier; unset means nobody can. Why the
other variables are set the way they are is under
[Railway settings and gotchas](#railway-settings-and-gotchas).

### Fly.io (alternative)

The repo also ships a `fly.toml`. Everything here runs from `server/`.

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

# Operator accounts: a comma-separated list of user ids. Only these accounts can run
# Discord imports or change an Instant Server's tier. Unset means nobody can.
fly secrets set OHIYO_OPERATOR_USER_IDS="<your-user-id>"

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

### Rate limits and client addresses

Login, registration and other limits are keyed on the client's address.

- **On Fly** nothing is needed: the server trusts `Fly-Client-IP` because `FLY_APP_NAME`
  is set.
- **Behind any other reverse proxy** set `TRUSTED_PROXY_HOPS` to the number of proxies
  in front of the server (usually `1`). The server then takes that entry from the
  right of `X-Forwarded-For`. Without it every client appears to come from the proxy
  and shares one bucket, including the registration limit.
- **Registration** is limited to 10 new accounts per hour per address
  (`OHIYO_REGISTER_LIMIT_PER_HOUR`, `0` turns it off). People registering from one
  shared address, such as a classroom, will hit it.
- **Login** is also limited to 10 attempts per minute per username
  (`OHIYO_LOGIN_LIMIT_PER_USERNAME_PER_MINUTE`, `0` turns it off). A side effect:
  someone who keeps sending attempts for a known username can keep that account from
  logging in for as long as they continue. Existing sessions are not affected. If
  that is used against your users, raise the limit or turn it off; the per-address
  limit still applies.
- **Local Discrawl import** reads media only from `OHIYO_DISCRAWL_MEDIA_ROOT`; the
  request can no longer choose the folder.

### Railway settings and gotchas

The hosted service runs on Railway from the same `Dockerfile` (`server/railway.json`
selects it and the `/healthz` check). Settings that differ from Fly:

- A volume mounted at `/data`, and `RAILWAY_RUN_UID=0`: Railway mounts volumes as
  root and the image otherwise runs as an unprivileged user that cannot write there.
- `PORT=3000` (and `BIND_ADDR=0.0.0.0:3000`) so Railway routes to the server's port.
- `TRUSTED_PROXY_HOPS=2`. Railway sends `X-Forwarded-For: <client>, <its edge>` and
  discards any value the client sent, so the client is the second entry from the
  right. With `1` every request is keyed on an edge address and the limits never
  trigger.
- Check the volume's write speed once after creating it. One volume we were given
  took 0.3 to 15 seconds per `fsync`, which stalls any request that hits a SQLite
  checkpoint; a second volume in the same region took about 25 ms. From
  `railway ssh`: `dd if=/dev/zero of=/data/.probe bs=4k count=8 conv=fsync` a few
  times, then delete the file. If it is slow, attach a new volume.
- Instant Servers are provisioned through Fly Machines. Without `FLY_API_TOKEN` a
  release build refuses to create them.

**The web app** runs as a second Railway service from `client/Dockerfile`: it builds
the Vite bundle (the backend address comes from `client/.env.production`) and serves it
with Caddy, which sets the same security headers as `client/public/_headers` does on
Cloudflare Pages. To ship an app update:

```bash
scripts/deploy-web.sh    # builds and deploys client/, then updates OHIYO_EXPECTED_APP_BUNDLE
```

`app.ohiyo.gg` is a custom domain on that service; its DNS records live at the
registrar (a CNAME to the target Railway shows, plus a `_railway-verify` TXT record).
Custom domains have to be added in the Railway dashboard; the CLI's login cannot.

### Rolling back

The launch-hardening release adds migration 40 (indexes only). An older server image
refuses to start against a database that has a migration it does not know. Before
rolling back to an image from before that release, run this once on the database (the
indexes themselves can stay):

```sql
DELETE FROM _sqlx_migrations WHERE version = 40;
```

### Backups — set this up before you have real users

The `/data` volume holds the SQLite DB: **all** messages (ciphertext for encrypted DMs
and group chats, readable text for everything else) *and* the encrypted `key_backups`
blobs. Losing it is unrecoverable, so back it up.

- **Railway volumes.** Nothing here is set up for you. Check what your Railway plan
  offers for volume backups before relying on them, and use the Litestream option
  below, which works on any host.
- **Fly volume snapshots (Fly only; baseline, automatic).** Fly snapshots every volume
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

### Signed file URLs (`OHIYO_REQUIRE_SIGNED_FILES`) — optional

The `/files/{id}` route is unauthenticated (avatars, icons, and attachments load via
plain `<img src>`, which can't send an auth header). As defense-in-depth, every file
URL the server emits now carries an HMAC capability signature — `/files/{id}?s=<sig>`,
where `sig` is derived from `JWT_SECRET` and the file id. **Enforcement is OFF by
default**, so this changes nothing unless you opt in:

```bash
fly secrets set OHIYO_REQUIRE_SIGNED_FILES=true                          # Fly
railway variable set --service ohiyo-server OHIYO_REQUIRE_SIGNED_FILES=true  # Railway
# "1" also works; unset/anything else = off
```

When on, `serve_file` rejects any request whose `?s=` signature doesn't match (returning
404 so it never reveals whether an id exists). When off, the `s` param is ignored and
serving is byte-for-byte unchanged.

> **Caveat — re-save existing assets before enabling.** Signing is store-time, so URLs
> are signed *as they are written*. Message attachments and new uploads are signed going
> forward automatically. But avatars, server icons, and banners set **before** you flip
> the flag hold a bare `/files/{id}` URL with no signature — they will 404 under
> enforcement until re-saved (re-upload / re-pick the avatar, icon, or banner). Only
> turn this on once you're prepared for that, or accept that pre-upgrade profile/icon
> images need a one-time re-save.

---

## 2. Voice (TURN) — for calls across the internet

STUN alone works on a LAN. Real calls between people behind home routers need a
**TURN relay**. The coturn config already lives in `infra/coturn/`.

1. Run coturn on a public host (a small VPS, or a second Fly app) using
   `infra/coturn/docker-compose.yml`. Set its `static-auth-secret`.
2. Point the Ohiyo server at it with secrets matching that value:

```bash
cd server
# On Railway, set the same three values with `railway variable set`.
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
#   VITE_SERVER_URL=https://<your-backend-host>

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
> see [§6](#6-cicd).

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

Installers can build with **ad-hoc macOS signing** when Apple Developer ID
secrets are missing. That keeps downloaded `.dmg` files structurally valid and
avoids the worst "app is damaged" failure, but normal users may still see Apple's
"could not verify Ohiyo is free of malware" Gatekeeper warning.

For the beta, `v*` tag releases can publish ad-hoc-signed Mac DMGs as long as the
site and release notes clearly say they are **not Apple-notarized yet** and may
require Finder → right-click → Open. For a smooth customer download, use official
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
4. Before claiming the Mac download is Apple verified, download the `.dmg` on a
   clean Mac and confirm it opens without the "Apple could not verify" warning.

### Windows signing
Obtain a code-signing certificate (OV/EV) and set the `tauri.conf.json`
`bundle.windows.certificateThumbprint` (or use Azure Trusted Signing).

### Auto-update (on since 0.3.0)

The desktop app asks the newest **published** GitHub release for `latest.json` and offers
the update; the person chooses when to install it. A draft release is invisible to it.

Updates are signed with a key made for this purpose (it is not a code-signing certificate):

| GitHub secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The private update key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

The public half is `plugins.updater.pubkey` in `client/src-tauri/tauri.conf.json`. Keep a
copy of the private key and its password outside GitHub: without them, installed copies
can no longer be updated.

Update bundles are made only by the release workflow, which switches
`bundle.createUpdaterArtifacts` on when the key is present. A plain `npm run tauri build`
needs no key and makes no update bundle.

**A copy you build yourself never looks for updates.** Only the release workflow switches
that on, by setting `VITE_DESKTOP_UPDATES=1` for its builds. This matters because the
config in this repository names the official key and release address: a hand-built copy
that looked for updates would be offered the official build, install it over yours, and
end up talking to the official server.

Want your own fork to update itself? Make your own pair with
`npm run tauri signer generate -- -w <file>`, put its public key and your release address
in `plugins.updater`, and set the two secrets; your release workflow then turns updates
on for your builds. Do not set `VITE_DESKTOP_UPDATES` while the config still names this
repository's key and address.

On Linux the AppImage replaces itself in place. A deb or rpm install updates through the
system's package tool, which asks for the administrator password; if that is not possible,
download the new package instead.

---

## 6. CI/CD

`.github/workflows/release.yml` builds the macOS (Apple Silicon + Intel) and Linux
installers on every `v*` tag (or via manual dispatch) and attaches them to a
**draft** GitHub Release. macOS has two explicit CI paths: Developer ID signed +
notarized when all Apple secrets are present, otherwise ad-hoc-signed Mac beta
fallback:

| Secret | Purpose |
|--------|---------|
| `VITE_SERVER_URL` | Backend URL baked into the bundle (`https://<your-backend-host>`) |
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
      once it's fixed (`https://<your-backend-host> wss://<your-backend-host>`).
- [ ] **Token storage.** The web client keeps the session token in
      `localStorage`. Acceptable in the packaged app; revisit if you ship a pure
      web build to untrusted origins.
- [x] **Proxy IPs.** On Fly the server keys rate limits on `Fly-Client-IP`. Behind any
      other reverse proxy set `TRUSTED_PROXY_HOPS` (see "Rate limits and client
      addresses"), or every client shares one bucket.
- [x] **Privacy policy + Terms of Service.** Landing pages live in `site/privacy.html`
      and `site/terms.html`, with footer links and sitemap coverage.
- [ ] **Load test** to replace the dev-machine benchmark numbers on the
      comparison page with production figures.
