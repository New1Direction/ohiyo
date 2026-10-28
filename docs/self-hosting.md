# Self-hosting: single-host chat baseline

This is an operator-managed **Docker Compose v2 + Linux** baseline, not a managed
hosting service. Build the web client and server from the **same tested Git revision**.
It runs one server, a static web container and a Caddy TLS edge. Only TCP 80/443
are published. API, WebSocket gateway and files share the web origin; there is no
public worker. Basic accounts, spaces and chat do not require AI, model keys,
Meilisearch, TURN, LiveKit or a paid service. The default explicitly disables the
embedded worker and Kikka admission. Voice across arbitrary networks is **not**
promised by this baseline.

## Prepare and start

Use a host you control with Docker Engine, the Compose v2 plugin, Python **3.11+**,
OpenSSL, adequate build memory/disk, and a local filesystem (not NFS) for SQLite.
Size storage for uploads plus at least 5 GiB spare; the default upload guard reserves
that much. Set sensible per-user quotas in `.env`. Plan off-host backups before users
join. Point a public DNS name (including any AAAA record) at this host, allow inbound
TCP 80/443 and outbound DNS/HTTPS for certificate issuance and builds. Do not place
another proxy/CDN in front without revisiting trusted proxy/address handling.

From the repository root, check out a reviewed release/tag or commit, then:

```bash
cd infra/selfhost
umask 077
cp .env.example .env
# Generate into the private file, never print keys into terminal/log output.
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path('.env')
s = p.read_text()
for name in ('JWT_SECRET', 'OHIYO_TOTP_KEY'):
    s = s.replace(name + '=\n', name + '=' + secrets.token_hex(48) + '\n')
p.write_text(s)
PY
# Edit .env privately: set OHIYO_DOMAIN and OHIYO_VERSION to the tested revision.
# The server image runs as UID 10001. Do not run it as root to fix permissions.
sudo install -d -o 10001 -g 10001 -m 0700 data
docker compose config --quiet
docker compose build server web
docker compose up -d
```

Do not run `docker compose config` without `--quiet` in logs: expanded config contains
secrets. Do not commit `.env` or put secrets in `VITE_*` variables. Run Compose from
`infra/selfhost`, without alternate project names, override files, volume paths or
replica counts: `backup.sh` deliberately targets exactly this stack. Never start a
second server against the same data, including during upgrades. Bind-mounted
`data/` is `/data` inside the server: SQLite, WAL/SHM, uploads, import staging and
any future `kikka/` worker state all persist there. Do not relocate worker files
outside `/data`. Caddy certificate/account state persists separately in
`caddy-data/` (mounted at its `/data`) and config in `caddy-config/`.

The web image's `VITE_SERVER_URL` build argument is set to `https://OHIYO_DOMAIN`.
Omitting that argument in other builds retains the existing hosted default from
`client/.env.production`; never edit that file for this stack. Changing your domain
requires rebuilding the web image and updating stored absolute file URLs or retaining
the old domain. Existing browser homes/tokens are not migrated automatically.

### Verify before inviting users

At your configured HTTPS origin, verify `/healthz` returns `ok`, `/` serves the app,
and `/api/v1/nonexistent` returns an API 404, **not** the HTML app shell. In two browser
sessions create accounts, a space/channel, send/read messages, reconnect, and upload
and reload an attachment. Browser network tools should show `/gateway` upgrading to
WebSocket (101), `/api/v1/*` and `/files/*` staying on your domain, and no requests to
the hosted backend. Repeat after `docker compose restart server`. Only the proxy
should have host ports (`docker compose ps`). These are required deployment checks,
not claims that this guide has tested your DNS/TLS/firewall or production data.

## Optional voice and AI

* For P2P NAT traversal, independently configure [coturn](../infra/coturn/README.md):
  public IP/realm, TLS certificates, TURN secret and relay firewall ranges. Add
  `TURN_SECRET`, `TURN_URLS` and optionally `TURN_TTL` **only to the server's
  environment** in a reviewed local Compose change. `.env` alone does not forward
  additional variables. Match the coturn secret and test a real relay candidate
  from an external/restricted network. HTTPS proxying alone does not relay UDP.
* For an SFU, independently configure [LiveKit](../infra/livekit/README.md), including
  its public node address, signaling TLS, API keys and media ports. Add
  `LIVEKIT_ENABLED=true`, `LIVEKIT_URL` (public `wss://`), `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` to the server environment, replacing the baseline's disabled
  value. Verify authenticated runtime config discovery and multi-client media;
  do not use the development key or assume the example stack supplies public TLS.
* AI is off. An advanced operator may separately review the existing
  [embedded Pi worker contract](../DEPLOY.md#optional-cohosted-school-practice-worker-railway-api-service-only).
  It requires explicit private credentials, routing, consent and stable encryption
  keys. Keep it embedded/loopback-only and all its durable state at `/data/kikka`.
  No separate worker service/port is supplied here. Do not use this baseline's backup
  wrapper for an independently running writer; first stop **every** such writer.

## Whole-volume backup (planned outage)

The existing `scripts/backup-restore-drill.sh` and Litestream cover SQLite only;
they are **not** whole-volume recovery. Never tar a live volume. A DB snapshot plus
uncoordinated uploads/worker copies can lose or replay important state.

With no other process writing `data/`, run from `infra/selfhost`:

```bash
# Destination must exist outside data/; use a NEW archive name every time.
sudo install -d -m 0700 /var/backups/ohiyo
sudo bash backup.sh /var/backups/ohiyo/pre-upgrade-2026-10-28.tar.gz
# Server (and embedded worker/Litestream, if enabled) remains stopped, on failure too.
# On success, explicitly resume only when you are ready:
docker compose start server
```

The wrapper stops the server container, confirms it is stopped, then archives
**all** of `data/`, including hidden files, SQLite WAL/SHM, uploads, Pi databases,
receipts and journals. It refuses to infer safety if no server container is found
or Docker cannot confirm shutdown. Do not run another Compose command concurrently.
It creates mode-0600 `.tar.gz` and `.tar.gz.sha256` files, never overwrites an archive,
and refuses symlinks, hardlinks and special files instead of silently omitting them.
On failure investigate before restarting; no automatic job retry or replay occurs.

Encrypt both archive and checksum and copy them off-host. A local checksum detects
accidental corruption, **not** malicious modification; retain trusted/encrypted
copies, restrict access and set retention. The archive contains private messages,
files and worker credentials/state. Preserve these **separately**, encrypted and
access-controlled, with the tested revision/image tags and Compose configuration:

* `.env`: stable `JWT_SECRET` and independent `OHIYO_TOTP_KEY` (sessions, signed file
  URLs and authenticator secrets depend on these).
* If enabled later: `KIKKA_CONNECTION_KEY`, `KIKKA_WORKER_TOKEN`, provider/voice keys,
  approved routing configuration and any object-store credentials. Losing keys can
  make restored encrypted state unusable. Never rotate keys as part of recovery.
* Caddy `caddy-data/` and `caddy-config/` while the proxy is stopped, or explicitly
  plan to reissue certificates with working DNS/ACME access and rate limits.

The full data backup does **not** include these separate host files. Client-side
end-to-end encryption recovery secrets still need users' own recovery arrangements.

## Restore and rehearse

Always restore into a **new, nonexistent directory**, never onto a live volume or
even an empty existing directory. Python validates checksum and archive paths/types
before creating the target. Run as root to retain numeric ownership (UID 10001).
If extraction fails, the partial directory is left for investigation and is not a
valid retry target. No tool deletes a target for you.

```bash
cd infra/selfhost
# Keep live writers stopped throughout recovery and validation.
docker compose stop server
sudo python3 volume.py restore /var/backups/ohiyo/pre-upgrade-2026-10-28.tar.gz /srv/ohiyo-restored
sudo python3 - <<'PY'
from pathlib import Path
import sqlite3
root = Path('/srv/ohiyo-restored')
assert (root / 'ohiyo.db').is_file(), 'restored server database is missing'
for p in root.rglob('*'):
    if p.is_file() and p.suffix in ('.db', '.sqlite'):
        with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as db:
            assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
print('SQLite integrity checks passed')
PY
```

Also compare known uploads byte-for-byte, check message/account counts and inspect
worker receipts/journals. A SQLite integrity result alone does not prove full recovery.
For cutover, preserve the old `data/` under a new name (do not delete it), then move
the validated restored directory to `infra/selfhost/data` **while stopped**. Moves
must stay on one filesystem; otherwise copy offline, retain ownership and revalidate.
Use the same server/web revision that created the backup and the separately saved
keys; verify permissions, then `docker compose up -d --no-build` and repeat the browser
chat/upload checks above. Reconcile uncertain worker outcomes before approving any
new work; restoration is not permission to replay model calls or external effects.

For a rehearsal, restore on an isolated host with its own DNS and outbound model/voice
access disabled; never mount the production data or run a second production worker.
Record archive checksum, revision, outage duration, integrity/count/file comparisons,
login/TOTP/chat checks and recovery time. Practice this before upgrades and periodically.
The repository's offline regression drill is:

```bash
python3 -B -m unittest discover -s infra/selfhost -p 'test_*.py' -v
```

It checks real SQLite committed-WAL recovery, byte-for-byte uploads and **fixture**
worker/Pi state, corruption/path/target refusals and a simulated Docker stop gate.
It does not execute Pi, make model calls, test Docker, issue TLS certificates or
certify a production restore.

## Explicit upgrades and rollback

There is no auto-updater/Watchtower. Record your old Git revision and preserve both
old image tags (`docker image save` to a protected off-host copy if needed). Review
release notes, configuration and migrations; rehearse against a restored copy first.
Before switching revisions, take a whole-volume backup above and save the separate
keys/configuration. Leave the server stopped. Check out the reviewed new revision,
set a new `OHIYO_VERSION` tag privately in `.env`, then:

```bash
docker compose config --quiet
docker compose build server web
# Old server must already be stopped: no rolling/overlapping SQLite replicas.
docker compose up -d --no-build
```

Startup applies embedded SQLite migrations. Repeat all acceptance checks before
allowing writes. If they fail, stop the new server; do not simply boot an old binary
against a newly migrated database or remove migration records. Restore the
**pre-upgrade whole volume** into a new directory, preserve the failed volume for
diagnosis, switch back to the saved old keys/config and both old image tags, and start
with `--no-build`. A rollback loses writes after that backup; communicate that recovery
point. Do not prune old images/backups until the upgrade is accepted and retention permits.
