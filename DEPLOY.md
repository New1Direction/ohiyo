# Shipping Ohiyo to real people

The family distribution path is **web-first**: open `https://app.ohiyo.gg` in a
browser, with an optional browser-managed home-screen/Dock installation. The web
client and backend must be deployed from the same tested revision. Native Mac
downloads remain experimental and are not a recommended family installation path.
See [current readiness gates](LAUNCH-STATUS.md) before changing production.

Ohiyo needs a **server in the cloud** whether people use the browser or desktop
client. The native packaging instructions below are for a future signed release;
Apple Developer enrollment is not required to use the web app.

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Ohiyo.app / .msi   │  HTTPS  │  Railway or Fly.io               │
│  (Tauri desktop client) │ ──────▶ │  • axum server  (Docker)         │
│  React bundle inside     │   WSS   │  • SQLite + uploads (volume)     │
│  a native window         │ ◀─────▶ │  • call relay (TURN, optional)   │
└─────────────────────────┘         └──────────────────────────────────┘
```

- **Backend host:** any host that runs a Docker image with one persistent volume.
  ohiyo.gg runs on Railway ([§1](#1-deploy-the-backend)); the repo also ships a
  `fly.toml` for Fly.io. Either way it is a single machine with a persistent volume.
- **Signing:** the published v0.3.1 Mac installers fail Gatekeeper. New native
  releases require Developer ID signing and notarization; see
  [§5](#5-code-signing--auto-update-required-for-release-downloads). The updater's
  separate verification key does not substitute for Apple signing.

---

## 1. Deploy the backend

Ohiyo needs exactly **one** running server and **one** persistent volume mounted at
`/data` (the SQLite database and uploads). Any host that runs a Docker image with a
volume works; both paths below build `server/Dockerfile`.

Both Dockerfiles require the **repository root as their build context**: the client
imports `brand/kikka-chinchilla-clean.png`, and the server embeds `.agents/skills/`.
For local builds, run `docker build -f server/Dockerfile .` or
`docker build -f client/Dockerfile .` from the repo root. The root `.dockerignore`
and `.railwayignore` allow only build inputs, excluding local secrets, databases,
uploads and build artifacts. Keep their allowlists in sync when adding build inputs;
`client/.env.production` is deliberately included and must contain only public config.

### Railway (what ohiyo.gg runs on)

From the repo root, with the Railway CLI logged in. Create a project, a service for the
server and a volume mounted at `/data` (`railway volume add`, or the dashboard).
In each service's **Settings**, leave **Root Directory** at `/` (not `server/` or
`client/`) and explicitly configure these build/deploy fields:

| Service | Dockerfile path | Health check | Timeout |
| --- | --- | --- | --- |
| `ohiyo-server` | `server/Dockerfile` | `/healthz` | 120 seconds |
| `ohiyo-web` | `client/Dockerfile` | `/` | 60 seconds |

Set one replica and an `ALWAYS` restart policy; the API must not overlap two
instances on its SQLite volume. On the current Railway API, `railwayConfigFile`
is deprecated and rejects updates. The builder enum also no longer accepts
`DOCKERFILE`: use the direct `dockerfilePath` setting (with builder `RAILPACK`)
and verify the build logs actually select that Dockerfile. The nested
`server/railway.json` and `client/railway.json` retain the intended settings as
references, but do not assume the platform applies them automatically.

Clear any old `RAILWAY_DOCKERFILE_PATH` override pointing to `Dockerfile`. If using
Git-triggered deploys with watch paths, include `.agents/skills/**` for the server
and `brand/**` for the web app, as well as each service's own directory and the root
ignore files. These service settings are required even for CLI uploads; Railway
does not select a Dockerfile from the `--service` name. Read back the effective
settings before uploading. Then:

```bash
# Required: the server REFUSES to start in release without JWT_SECRET and PUBLIC_BASE_URL.
railway variable set --service ohiyo-server \
  JWT_SECRET="$(openssl rand -base64 48)" \
  PUBLIC_BASE_URL="https://<your-service>.up.railway.app" \
  OHIYO_OPERATOR_USER_IDS="<your-user-id>" \
  RAILWAY_RUN_UID=0 PORT=3000 BIND_ADDR=0.0.0.0:3000 TRUSTED_PROXY_HOPS=2

# Build server/Dockerfile on Railway and wait for the health check (/healthz).
railway up . --path-as-root --service ohiyo-server --ci

curl https://<your-service>.up.railway.app/healthz     # -> ok
```

`OHIYO_OPERATOR_USER_IDS` is a comma-separated list of user ids. Only those accounts can
run Discord imports or change an Instant Server's tier; unset means nobody can. Why the
other variables are set the way they are is under
[Railway settings and gotchas](#railway-settings-and-gotchas).

### Optional cohosted school-practice worker (Railway API service only)

The server image includes **Node.js 26** and the actual **Pi 1.3.0** worker,
installed from `worker/package-lock.json` with `npm ci --ignore-scripts --omit=dev`.
Packaging does not enable it. With `KIKKA_EMBEDDED_WORKER` unset (or anything other
than exactly `1`), startup and Litestream restore/replication remain unchanged.
There is no separate public worker service or port: only the existing API port
3000 is exposed. Include `worker/**` in the API service's Git deploy watch paths.

The image includes reviewed, nonsecret configurations from
`worker/config/practice-routing.json` and `worker/config/practice-worker.json`,
at the immutable paths `/opt/ohiyo-worker/config/practice-routing.json` and
`/opt/ohiyo-worker/config/practice-worker.json`. The school/no-browse worker
configuration is exactly:

```json
{"approvedUrls":[]}
```

Do not add `computer` configuration or `KIKKA_TRAVEL_URL`: this embedded school
profile refuses them, so computer, coding and travel are not enabled. Empty
`approvedUrls` is accepted only with routed model access; the non-routed profile
still requires 1–20 pages, and both profiles retain the 20-page maximum.

The reviewed route selects Groq `openai/gpt-oss-120b` for all four roles, with a
131,072-token context, 4,096-token output maximum and budget rates of **$0.15 input /
$0.60 output per million tokens**. Verify provider pricing before a later rollout;
these are budget rates, not a free-tier promise. The connection uses `groq/*`
mapping and reads `KIKKA_DEFAULT_API_KEY` **only from the API environment**. A
missing/invalid route is not permission to fall back to another provider. No key
belongs in these JSON files or public Vite variables. Supply a stable
`KIKKA_CONNECTION_KEY` (at least 32 characters) to encrypt saved personal
connections; preserve it across restarts. Setting `KIKKA_USER_ID='*'` makes the
feature available to all authenticated users, not unauthenticated visitors;
omitting it disables Kikka. Per-operation provider/data/budget consent remains
required. To restrict rollout, use a specific authorized user id instead.

After those files and authorized routes exist, set these **on `ohiyo-server`, not
`ohiyo-web`**, in addition to all existing production variables:

```bash
railway variable set --service ohiyo-server \
  KIKKA_EMBEDDED_WORKER=1 \
  KIKKA_RUNTIME=pi \
  KIKKA_USER_ID='*' \
  KIKKA_WORKER_TOKEN="$(openssl rand -hex 32)" \
  KIKKA_WORKER_CONFIG=/opt/ohiyo-worker/config/practice-worker.json \
  KIKKA_WORKER_DIRECTORY=/data/kikka \
  KIKKA_WORKER_PORT=3102 \
  KIKKA_WORKER_URL=http://127.0.0.1:3102/command \
  KIKKA_MODEL_ROUTING=1 \
  KIKKA_ROUTING_CONFIG=/opt/ohiyo-worker/config/practice-routing.json \
  KIKKA_ROUTING_ACCESS_URL=http://127.0.0.1:3000/api/v1/burrow/internal/model-access
```

Use a stable private service token of **at least 32 characters** shared by the API
and worker; the example generates 64 hex characters. Preserve the value after
initial provisioning: it also protects saved worker subscription accounts. Never
put it in public Vite variables. The directory defaults to `/data/kikka` if unset;
any different directory is rejected in embedded mode. Ensure `/data` is writable
by the service user (`RAILWAY_RUN_UID=0` as above), and preserve/back up the whole
volume, including worker journals. Litestream backs up the API SQLite database,
**not** the worker's other databases/files. If changing either port, keep the
loopback URLs consistent with `KIKKA_WORKER_PORT` and the API's `BIND_ADDR` port.

The API retains its complete environment. The worker receives **only**
`KIKKA_WORKER_CONFIG`, `KIKKA_WORKER_DIRECTORY`, `KIKKA_WORKER_TOKEN`,
`KIKKA_WORKER_PORT`, `KIKKA_MODEL_ROUTING` and `KIKKA_ROUTING_ACCESS_URL`.
It resolves authorized credentials through the loopback API at dispatch time;
JWT, object-store, connection-encryption and ambient model-provider keys are not
inherited. This is environment isolation, not a separate OS/filesystem sandbox.

Opt-in starts a subreaped supervisor, the worker and the unchanged API/Litestream
startup path. Either peer exiting, even successfully, terminates the other and
fails the container. SIGTERM/SIGINT stop both process groups; after five seconds,
unresponsive processes are killed. The supervisor never restarts a worker or
resubmits an uncertain operation. Hosting-level restart policy is separate;
reconcile saved outcomes before authorizing another attempt. Startup/readiness
does not initiate model inference. This packaging does not bypass user approval,
turn on a practice request, or certify model output for school use.

To return to legacy API-only startup, unset `KIKKA_EMBEDDED_WORKER` and restart the
service; keep `/data/kikka` and stable secrets for reconciliation. No deployment,
configuration provisioning or live model smoke test is implied by these steps.

### Fly.io (alternative)

The repo also ships `server/fly.toml`. Management commands below run from `server/`;
the deploy command switches to the repo root for the shared build context.

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

# Recommended: the key two-factor sign-in secrets are encrypted under. Without it they're
# encrypted under a key derived from JWT_SECRET, and rotating JWT_SECRET breaks everyone's
# authenticator codes (recovery codes keep working).
fly secrets set OHIYO_TOTP_KEY="$(openssl rand -base64 48)"

# Operator accounts: a comma-separated list of user ids. Only these accounts can run
# Discord imports or change an Instant Server's tier. Unset means nobody can.
fly secrets set OHIYO_OPERATOR_USER_IDS="<your-user-id>"

# Ship it with the repository root as context, preserving the service config.
(cd .. && fly deploy --config server/fly.toml)

# Verify.
curl https://ohiyo-<you>.fly.dev/healthz     # → ok
```

Notes baked into the config:

- **`Dockerfile`** is a multi-stage Rust build → a slim Debian runtime with CA
  certificates, Litestream, Discrawl, Node 26 and the opt-in Pi worker. SQLx bundles
  SQLite and reqwest uses rustls; no system OpenSSL is needed.
- **`fly.toml`** keeps **one machine always running** (`auto_stop_machines = off`,
  `min_machines_running = 1`). A chat/voice server holds live WebSocket
  connections and presence — it must not sleep.
- **WebSockets** (`/gateway`) work over Fly's HTTP service automatically.
- The volume at `/data` holds both `ohiyo.db` and the `uploads/` directory,
  so messages and files survive deploys and restarts.
- Because they share it, uploads are capped twice: each account may store 1 GiB in
  total (`MAX_UPLOAD_BYTES_PER_USER`), and once the volume is down to 5 GiB free
  (`MIN_FREE_DISK_BYTES`, `0` turns this off) uploads are refused with 507 so the
  database always has room to write. Size both to your volume.

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

The hosted service runs on Railway from `server/Dockerfile`, with `/healthz` as
its health check. Configure those direct service settings as described above;
the nested JSON is a reference, not proof of the platform's effective config.
Settings that differ from Fly:

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
  release build refuses to create them, and the paid plan isn't sold either (Stripe
  settings: `GO-LIVE.md` §3b).

**The web app** runs as a second Railway service from `client/Dockerfile`: it builds
the Vite bundle (the backend address comes from `client/.env.production`) and serves it
with Caddy, which sets the same security headers as `client/public/_headers` does on
Cloudflare Pages. To ship an app update:

```bash
scripts/deploy-web.sh    # uploads repo root, builds client/Dockerfile, updates OHIYO_EXPECTED_APP_BUNDLE
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
  credentials, and `LITESTREAM_ENDPOINT` for any store other than AWS S3, such as
  Cloudflare R2) and the SQLite WAL streams to object storage for point-in-time
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
**TURN relay** for the calls that can't connect directly. The server supports two;
set up either (or both).

The server hands out relay credentials at `GET /api/v1/ice-servers`; the client
fetches them before each call. The STUN servers come first, so a call still connects
directly whenever it can and only uses the relay when that fails.

### Cloudflare Realtime TURN (what ohiyo.gg uses)

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
   Copy its **Turn Token ID** and **API Token**.
2. Set both on the server:

```bash
railway variables --service ohiyo-server \
  --set CLOUDFLARE_TURN_KEY_ID="<Turn Token ID>" \
  --set CLOUDFLARE_TURN_API_TOKEN="<API Token>"
```

On each call the server asks Cloudflare for credentials that last `TURN_TTL` seconds
(a day by default); the API token never leaves the server. If Cloudflare fails or
takes more than 3 seconds, the call gets a direct-only answer instead of waiting. One
account can make the server ask at most 20 times a minute.

Pricing (October 2026): TURN traffic is $0.05 per GB sent from Cloudflare to callers,
with the first 1,000 GB a month free, shared with Cloudflare's SFU. Only the calls that
can't connect directly use it.

### Self-hosted coturn

The coturn config already lives in `infra/coturn/`.

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

The server mints short-lived coturn credentials from that secret on each call.

### GIF search (KLIPY, optional)

The composer's GIF tab searches [KLIPY](https://docs.klipy.com) through your server (Tenor's API,
which the app used to call, was shut down on 30 June 2026). Create an API key on KLIPY's
partner site and set it on the server:

```bash
KLIPY_API_KEY=your-klipy-key
```

Without it the app shows no GIFs tab. With it, searches go from your server to KLIPY (not from
people's browsers), and the GIF images load from KLIPY's media hosts in the browser: KLIPY's
integration rules don't allow re-hosting or caching their media. The search box says "Search
KLIPY", as their attribution rules require.

---

## 3. Build the desktop app

Everything here runs from `client/`.

```bash
cd client

# Point the packaged app at YOUR backend (this is baked in at build time).
# Edit client/.env.production:
#   VITE_SERVER_URL=https://<your-backend-host>

bun install
bun run tauri build
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

## 5. Code signing & auto-update (required for release downloads)

Release jobs fail before building if the update signing key is missing. Mac jobs
also require all six Apple signing/notarization secrets; there is no ad-hoc release
fallback. Local `bun run tauri build` still permits ad-hoc development builds, but
those are not family-ready downloads and must not be represented as Apple verified.

The published v0.3.1 Mac beta predates this gate. Its ARM download was checked on a
Mac on 2026-10-23: signature integrity passed, but Gatekeeper rejected it and no
notarization ticket was present. This workflow change does not repair that existing
download. A new signed, notarized version must be built and tested before publication.

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
3. Once release publication is authorized, push a `v*` tag or run the Release
   workflow manually. Missing credentials stop the corresponding release job.
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
`bundle.createUpdaterArtifacts` on when the key is present. A plain `bun run tauri build`
needs no key and makes no update bundle.

Use native Tauri 2 update artifacts (`createUpdaterArtifacts: true`), never
`"v1Compatible"`. The updater's optional legacy ZIP feature is disabled to remove
vulnerable ZIP dependencies: Linux updates must use raw `.AppImage`, `.deb` or
`.rpm` files, and future Windows updates must use raw `.exe` or `.msi` installers.
Do not point Linux updates at `.AppImage.tar.gz`; that legacy wrapper is not
supported. macOS `.app.tar.gz` updates remain supported. The published v0.3.1
manifest and the release workflow already use these native formats.

**A copy you build yourself never looks for updates.** Only the release workflow switches
that on, by setting `VITE_DESKTOP_UPDATES=1` for its builds. This matters because the
config in this repository names the official key and release address: a hand-built copy
that looked for updates would be offered the official build, install it over yours, and
end up talking to the official server.

Want your own fork to update itself? Make your own pair with
`bun run tauri signer generate -- -w <file>`, put its public key and your release address
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
