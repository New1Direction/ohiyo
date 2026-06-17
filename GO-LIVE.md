# Go live — `ohiyo.gg`

You own `ohiyo.gg` (Porkbun). This is the runbook to make it *do things*: serve the
landing page, and (when you're ready) power live **Instant Servers**. Steps marked
**[you]** need your accounts; everything else is already in the repo.

The smart move: **move DNS to Cloudflare once**, and it serves both the website (Cloudflare
Pages) and the wildcard `*.ohiyo.gg` that Instant Servers needs.

---

## 1. Point DNS at Cloudflare **[you]**

1. Create a free [Cloudflare](https://dash.cloudflare.com) account → **Add a site** → `ohiyo.gg`.
2. Cloudflare shows you **two nameservers**. In **Porkbun → Domain → Authoritative
   Nameservers**, replace Porkbun's with Cloudflare's two. (Propagation: minutes–hours.)
3. Done — you now manage `ohiyo.gg` DNS in Cloudflare.

## 2. Ship the landing page → Cloudflare Pages **[you]**

The site is static and self-contained in [`site/`](site/) (`index.html` + `styles.css` +
`app.js` + `kikka.svg`). Nothing to build.

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → pick
   `New1Direction/ohiyo`.
2. Build settings: **Framework preset = None**, **Build command = (empty)**,
   **Build output directory = `site`**.
3. Deploy. You get a `*.pages.dev` URL — confirm it looks right.
4. Pages → **Custom domains → Set up a domain → `ohiyo.gg`** (and add `www` → redirect to
   apex if you want). Cloudflare wires the DNS automatically.

✅ `https://ohiyo.gg` is live. (To preview locally first: `cd site && python3 -m http.server`.)

## 2b. Browser sign-up client (`app.ohiyo.gg`) → Cloudflare Pages **[you]**

Lets anyone sign up in a browser — no download. It's the same React app the desktop build
wraps (verified: the e2e suite drives it in a plain browser), pointed at the live backend.
The production build is verified (`ohiyo.fly.dev` baked in, CSP allows it); this is a second
Cloudflare Pages project + DNS.

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → `New1Direction/ohiyo`.
2. Build settings:
   - **Root directory** = `client`
   - **Framework preset** = `Vite` (or None)
   - **Build command** = `npm ci && npm run build`
   - **Build output directory** = `dist` (i.e. `client/dist`)
3. **Environment variables** → `VITE_SERVER_URL = https://ohiyo.fly.dev` (baked into the bundle at build).
4. Deploy → confirm the `*.pages.dev` URL loads the auth screen.
5. Pages → **Custom domains → `app.ohiyo.gg`** (Cloudflare wires the DNS).
6. *(Recommended, optional)* Lock CORS to the web origin: `fly secrets set CORS_ALLOWED_ORIGINS=https://app.ohiyo.gg`
   on the backend. Until set, the server allows any origin, so the web client already works without it.

✅ `https://app.ohiyo.gg` → browser sign-up against `ohiyo.fly.dev`. Invite links use the current
origin, so invites from the web app point at `app.ohiyo.gg` (correct). Desktop app unaffected.

## 3. (When ready) Live Instant Servers **[you]**

The control plane is built and tested ([`server/src/provision/`](server/src/provision/)); it
just needs a cloud to talk to. It auto-switches from the in-memory fake to **Fly Machines**
the moment `FLY_API_TOKEN` is present.

1. **Fly app for instances:** `fly apps create ohiyo-instances`.
2. **Push the server image** to Fly's registry so machines can boot it:
   ```bash
   cd server
   fly auth docker
   docker build -t registry.fly.io/ohiyo-instances:latest .
   docker push registry.fly.io/ohiyo-instances:latest
   ```
3. **Wildcard DNS** in Cloudflare: add `*.ohiyo.gg` → a `CNAME` to your Fly app's hostname
   (or an `A`/`AAAA` to its IPs), so `yourcrew.ohiyo.gg` resolves to a provisioned machine.
   (Fly's `fly certs add "*.ohiyo.gg"` issues the wildcard TLS cert.)
4. **On the control-plane host** (the main Ohiyo server), set:
   ```bash
   FLY_API_TOKEN=<fly auth token>          # `fly tokens create org`
   FLY_APP_NAME=ohiyo-instances
   FLY_IMAGE=registry.fly.io/ohiyo-instances:latest
   FLY_PRIMARY_REGION=iad                   # optional, defaults to iad
   ```
   `build_state` now constructs `FlyProvisioner` instead of the fake.
5. **Smoke test:** `POST /api/v1/instances` (authenticated) → confirm a real machine boots,
   `/healthz` passes, and `https://<subdomain>.ohiyo.gg` answers.

> Per-instance volumes are created automatically by the provisioner (3 GiB, for the SQLite
> DB + uploads). Free-tier cap is 3 instances/user, rate-limited to 5 provisions/user/hour.

## 4. Optional — move the API onto the brand domain **[you]**

Today the desktop app talks to your own self-hosted backend (e.g. `your-app.fly.dev`),
set in [`client/.env.production`](client/.env.production). If you'd like `api.ohiyo.gg` instead:
add a Cloudflare `CNAME api → <fly-app>.fly.dev`, `fly certs add api.ohiyo.gg`, set
`VITE_SERVER_URL=https://api.ohiyo.gg`, and rebuild the desktop app.

---

## Status

| Piece | State |
|---|---|
| Landing page (`site/`) | ✅ built — deploy via step 2 |
| Instant Servers control plane | ✅ built + tested — wire via step 3 |
| Domain `ohiyo.gg` | ✅ owned (Porkbun) |
| Cloudflare DNS + Pages | ⏳ **[you]** — step 1–2 |
| Fly instances app + wildcard DNS | ⏳ **[you]** — step 3 |
