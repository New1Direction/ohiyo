# Ohiyo Instant Servers — Design Spec

**Date:** 2026-06-16
**Status:** Approved design (pre-implementation)
**Author:** Brainstormed with Connor

---

## 1. North star

Let anyone stand up their own Ohiyo community server **in one tap, without thinking about
infrastructure** — and still genuinely *own their data*. The model is Minecraft Realms,
not Discord: we host it so it "just works," but it's end-to-end encrypted (we can't read
it), exportable at any time, and one button away from moving to their own box.

> Reach Signal-and-Wickr-level encryption **without sacrificing ease of use.** Instant
> Servers is the ease-of-use half made concrete.

## 2. Problem

Self-hosting is the privacy story, but raw self-hosting is where most people quit
("what's my IP, how do I port-forward, how do I keep it alive"). Discord solves ease of
use but reads your data and taxes the good features per-head. We want Discord's
zero-friction onboarding *and* Signal's ownership — at the same time.

The tension we resolved: **"don't make them think about it" pulls toward us hosting it,
but someone still pays for the box and keeps it alive.** Minecraft already solved this:
Realms is managed + one-click + paid by a small sub, and *world data is downloadable* —
so "we host it" and "you own your data" coexist. With E2E, our version is strictly
stronger: even the managed box only ever holds ciphertext.

## 3. The model: Realms-shaped managed hosting + real ownership

We host the server (best UX), but ownership is guaranteed by three properties layered on
top:

- **Unreadable** — the per-community server is E2E; it relays/stores ciphertext only. The
  control plane never holds message plaintext or E2E keys.
- **Exportable** — "Download my server" produces the full encrypted data set on demand,
  always, including on the free tier.
- **Portable** — "Graduate to my own box" hands over the image + their data and/or
  one-click-deploys it into their own cloud. They can leave anytime with everything.

This is the thing Discord structurally cannot offer and Minecraft Realms can only half-offer
(Mojang can read your world; we cannot read your messages).

## 4. The three tiers

| | **Free (managed)** | **Paid (managed)** | **Self-host** |
|---|---|---|---|
| Who runs the box | Us | Us | You |
| Cost | $0, no card | **< one Nitro (~$5–8/mo)** | $0 forever |
| Uptime | Sleeps when idle, sub-second wake | Always-on | However you run it |
| Caps | Cost-honest member/storage caps | Higher caps, custom domain | None |
| Onboarding | One tap in-app | One tap + upgrade | One-liner / one-click-to-cloud / BYO-VM |
| E2E + export + migrate | ✅ | ✅ | ✅ |

All three share the same server image and the same ownership guarantees. Users can migrate
**between** tiers with one click (free → paid → self-host and back).

### Pricing anchor — the Nitro comparison

The paid tier is deliberately pinned **below one Discord Nitro**, because the comparison is
both a price anchor and the headline marketing hook:

- Discord Nitro (~$9.99/mo) buys *one person* a fancier avatar + HD; real server perks are
  paywalled again behind Server Boosts (~$4.99 each). It's a **per-head** tax — a 20-person
  crew that all wants HD pays ~$200/mo, forever, for cosmetics.
- The same ~$8/mo on Ohiyo runs an **always-on, encrypted server for the entire community**,
  all "premium" features included for everyone, with cost-per-person *dropping* as you grow.

> One Discord Nitro gets you a shinier avatar. The same money runs your whole community —
> encrypted — on Ohiyo.

A side-by-side Nitro-vs-Ohiyo block is a landing-page deliverable (out of scope for this
spec; see §11).

## 5. Free-tier principles (the trust contract)

The audience is two crowds — the self-host/privacy crowd (values no-lock-in, no rug-pull,
honest pricing) and Discord-refugee community-runners (value "it just works, free, no
card"). The free tier serves both **only if** it follows four principles:

1. **Cost-honest, never coercive.** Limits exist because compute costs money (it naps when
   idle; storage is capped) — never to *force* an upgrade (no artificial member walls, no
   "your server dies in 3 days unless you pay," no nag popups).
2. **Untouchable $0 self-host floor.** Self-host is free forever and loudly advertised:
   "Don't like that it sleeps? Run it yourself for $0 — here's the one-liner." This single
   fact disarms the entire "free-tier trap" suspicion.
3. **Radical transparency.** Publish the real economics: "a server costs us ~$X/mo of
   compute; managed-always-on is $Y; here's how the free tier stays alive." Open-book
   pricing is a trust-builder with this audience, not a liability.
4. **Export + graduate always available**, on every tier including free.

## 6. Architecture

Four components. Only the control plane and notification relay are new; the per-community
server already exists.

### 6.1 Control plane (new, small orchestrator)

The only stateful piece we own. Authenticated (the user already has an Ohiyo account;
creating a server is an authed action). Responsibilities:

- **Provision** — create a per-community instance from the existing Ohiyo server image,
  attach a fresh volume, inject a unique `JWT_SECRET` and the assigned `PUBLIC_BASE_URL`,
  wait for `/healthz`, return the URL.
- **Registry** — store infra metadata only: `{community_id → machine_id, volume_id,
  subdomain, owner_account, tier, status}`. **No message data, no E2E keys.**
- **Lifecycle** — start/stop (sleep), suspend (non-payment/abuse), delete, trigger export.
- **DNS** — assign a `*.ohiyo.gg` subdomain routed to the instance.

### 6.2 Per-community instance (reuse — already built)

Exactly today's server: one axum binary + SQLite DB + uploads on a persistent volume, with
Litestream continuous backup to object storage. Recommended substrate: **Fly Machines**
(Firecracker microVMs: sub-second boot, per-second billing, **auto-stop when idle** and
**wake-on-request** via Fly Proxy — the "Aternos nap" built in, but ~1000× faster to wake).
Already in the repo: `server/Dockerfile`, `server/fly.toml`, `server/docker-entrypoint.sh`,
`infra/litestream/`, `/healthz`. The missing layer is orchestration, not the box.

### 6.3 Notification relay (new — solves the chat-specific sleep wrinkle)

A Minecraft world can sleep with zero downside; a **chat server that sleeps can't push a
2am DM notification.** Resolution: a single always-on, shared, lightweight relay holds
device push tokens (APNs/FCM) and emits pushes.

Key insight that makes sleep safe: **receiving a message inherently wakes the server** — a
sender has to connect to deliver, which boots the microVM. So at the moment a message
lands, the community server is awake and fires a push *request* to the relay before going
back to sleep. The relay only holds tokens and talks to APNs/FCM (which every microVM
shouldn't each carry creds for). Push payload carries **no content** (content is E2E); it
says "you have a message." The relay learns only metadata (who gets pinged, when) — this is
documented, and self-hosters can run their own relay or disable push.

### 6.4 Existing building blocks reused

`Dockerfile`, `fly.toml`, Litestream backups, `/healthz`, and `infra/coturn/` (TURN for
voice) all carry over unchanged.

## 7. Data flow

- **Create** — Tap "Create your server" → control plane provisions instance + volume +
  subdomain → waits for `/healthz` → app drops the user straight into the live server. No
  cloud console, no card (free tier).
- **Message while asleep** — Sender connects → Fly Proxy wakes the microVM → server accepts
  + stores ciphertext → fires a content-free push request to the relay for offline
  recipients → idles back to sleep. Recipients' reconnect wakes it again to sync.
- **Export** — "Download my server" → signed tarball of the latest Litestream snapshot
  (encrypted DB + uploads). Available on every tier.
- **Graduate to own box** — Hand over (a) the public Docker image, (b) the data export, and
  (c) a one-click deploy-to-your-cloud template that ingests the export; user repoints the
  app's server URL. Optional redirect from the old subdomain.

## 8. Error handling & failure modes

- **Provision fails** (capacity, API error) — registry marks `failed`, no orphan volume
  charged, app shows a friendly retry; provisioning is idempotent on `community_id`.
- **Wake fails / cold-start slow** — app shows "waking your server…" with a bounded timeout
  and retry; falls back to a status page, never a silent hang.
- **Quota / abuse** — per-account server cap and rate limits enforced at the control plane.
  Because E2E means we **cannot** moderate content, abuse handling relies on metadata-based
  rate limits, reports, and machine **suspension** (cut off a known-bad relay) — plus the
  self-host escape valve. This limitation is acknowledged honestly, not hand-waved.
- **Non-payment** (paid tier) — grace period → sleep/suspend (never instant delete);
  export remains available throughout; data retained for a stated window before deletion.

## 9. Security & privacy

- Control plane stores infra metadata only — **never** plaintext or E2E keys.
- Each instance gets a **unique** `JWT_SECRET`; a correct `PUBLIC_BASE_URL` (no baked-in
  localhost links).
- Push payloads are content-free; relay sees metadata only, documented and self-hostable.
- E2E boundary tests (already in CI) must continue to prove a removed member can't read the
  next message — the hosting layer changes nothing about the crypto boundary.

## 10. Testing strategy

- **Control plane unit tests** — provision/sleep/wake/suspend/delete state machine;
  idempotent provisioning; quota enforcement.
- **Integration** — provision a real instance in a staging Fly org (or a faked Machines
  API), assert `/healthz`, assert subdomain routing.
- **Export round-trip** — create → write data → export → import into a fresh instance →
  data intact.
- **Graduate** — export → deploy-to-cloud template ingests it → app reconnects to the new
  URL.
- **Notification relay** — message on a sleeping server → content-free push fired to the
  right tokens; no push content leakage.
- **Privacy regression** — control plane never observes plaintext/keys; existing E2E
  boundary suite stays green.

## 11. Scope & build order

This spec is the architecture for the whole feature; implementation decomposes into phases,
each getting its own implementation plan (via writing-plans):

1. **MVP — provision + connect.** Control plane can create a real per-community instance on
   Fly and drop the app into it. (Always-on at first; no sleep yet.)
2. **Sleep / wake.** Auto-stop idle, wake-on-request, "waking…" UX.
3. **Notification relay.** Content-free push for sleeping servers.
4. **Export + graduate.** Download-my-server + move-to-own-box flows.
5. **Tiers + billing.** Free vs paid limits, payment processor, grace/suspend lifecycle.
6. **Landing comparison.** Nitro-vs-Ohiyo block + "launch your own server" CTA (ties into
   the public landing page — a separate deliverable).

### Out of scope / YAGNI (for now)

- Multi-region / geo-routing of instances.
- Federation between community servers.
- A bespoke billing system (integrate a standard processor when we reach phase 5).
- The full public marketing landing page (separate track; this feature only owns the
  comparison block + CTA).

## 12. Open questions

- **Substrate confirm:** Fly Machines is the recommendation (sub-second wake + auto-stop).
  Hetzner/DO are cheaper for always-on but lack built-in wake-on-request — revisit if Fly
  per-instance cost is too high at scale.
- **Free-tier exact caps:** member/storage numbers to be set from real measured
  per-instance cost (principle: cost-honest, generous, never coercive).
- **Subdomain vs custom domain** on free vs paid: free gets `*.ohiyo.gg`; custom domain is a
  paid perk — confirm.
