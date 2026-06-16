# Ohiyo Roadmap — the hub for doing things together

**Vision:** the best place for friends to *be together* while they play games, watch
things, or work — not just a chat app, but the room you hang out in. Free, self-hostable,
AGPL, no data harvesting. We win not by out-featuring incumbents but by being the
warmest, smoothest, most *present* place to share an activity.

The product organizes around three things people do together:

## 🎮 Play
See what friends are playing and drop into the action.

- [x] **Rich presence / activity** — "Playing / Watching / Working on / Listening to ___", live in the member list
- [x] Voice / video / screen-share (peer-to-peer WebRTC)
- [x] **LiveKit SFU foundation** — server token endpoint + infra (scales voice past the ~5-person P2P ceiling)
- [x] LiveKit **client engine** — drop-in `useWebRTCLiveKit`, flag-gated + lazy-loaded. **Token path live-verified against a real LiveKit server** (its `TokenVerifier` accepts the self-minted join token + grants); a full multi-party *browser* call is the remaining UI-level check.
- [x] **"Join my voice"** — see who's in voice in the member list and one-click join them
- [ ] Game detection / auto-presence (desktop), rich-presence art

## 📺 Watch
Watch shows and videos in sync, together.

- [x] **Watch party** — synced play/pause/seek across a channel, **YouTube + direct media** (IFrame API)
- [ ] Screen-share with audio (have the transport; needs the watch-party UX)
- [ ] Reactions/timeline pinned to playback position

## 💼 Work
A calm, fast place to get things done with a team.

- [x] Servers, channels, categories, threads-of-thought, DMs
- [x] **Full-text search** (Meilisearch, with SQL fallback)
- [x] **Link-preview embeds** (server-resolved, SSRF-hardened)
- [x] Read receipts, reactions, edits, pins, attachments, polls, custom emoji
- [x] Roles & permissions, invites, moderation
- [ ] "Heads-down" / focus presence; do-not-disturb
- [ ] Code blocks with syntax highlighting; collaborative docs/canvas

## 🏠 Host
Your own encrypted server, in one tap — and you actually own it. Like Minecraft Realms, if Realms couldn't read your world.

- [x] **Instant Servers — Phase 1 (provision + connect)** — a control plane that spins up a dedicated per-community instance behind a `MachineProvisioner` trait (real Fly Machines impl + a zero-infra fake selected by `FLY_API_TOKEN`), an **atomic** free-tier cap, owner-scoped + rate-limited `/api/v1/instances`. **Adversarially reviewed and fixed** (TOCTOU cap-bypass, cap lockout, empty-volume data loss, untested failure path — all closed); build / clippy / 8 new tests green. Live provisioning gated on a Fly token + the `ohiyo.gg` domain.
- [x] **Realms-shaped ownership model** — we host it, but the box only ever holds ciphertext (E2E); the design bakes in export + one-click "graduate to your own box", priced below one Discord Nitro. Spec: [`docs/superpowers/specs/2026-06-16-instant-servers-design.md`](docs/superpowers/specs/2026-06-16-instant-servers-design.md).
- [ ] **Phase 2 — sleep/wake** — idle instances auto-stop and wake-on-request (sub-second), with a "waking…" UX
- [ ] **Phase 3 — notification relay** — content-free pushes so a *sleeping* server can still ping you at 2am
- [ ] **Phase 4 — export + graduate** — download-my-server + move-to-your-own-box flows
- [ ] **Phase 5 — tiers + billing** — free (sleeps) vs paid (always-on, custom domain), payment + suspend/grace lifecycle
- [ ] **Phase 1b — in-app server switch** — point the running client at a freshly-provisioned `*.ohiyo.gg` URL (the client is single-server at build time today)

## Foundations (cross-cutting)
- [x] Rust (axum + sqlx/SQLite) server, React 19 + Tauri client, **Daybreak**/Dusk design
- [x] Quality gate: ESLint (a11y as errors), tsc, cargo test, 22-suite e2e, GitHub Actions CI
- [x] **AGPL-3.0** licensed; adversarial security review pass (SSRF / XSS / injection / JWT)
- [x] Presence **snapshot on connect** (see who's online + their activity the moment you open the app)
- [ ] Multi-node scale: NATS/Redis gateway fan-out, Postgres option
- [ ] Mobile build (Tauri mobile); push notifications
- [x] **Signal-grade E2E encryption** (incumbents won't) — **one-click encrypted DMs** with **forward secrecy**: X3DH async session setup + Double Ratchet (`@privacyresearch/libsignal-protocol-typescript`, no hand-rolled crypto). Server runs a public **prekey directory** (identity + signed prekey + single-use one-time prekeys); ratchet keys never leave the device. Zero key handling — keys auto-exchanged, a darker "encrypted mode" with a banner. **Safety numbers** (native-crypto SHA-512 fingerprint) for optional out-of-band MITM verification. Forward secrecy means ciphertext can't be re-decrypted, so plaintext is cached on-device for history reloads. Legacy ECDH-P256/AES-GCM (`v1.`) kept as a fallback. **Two-client verified.**
- [x] **Multi-device E2E** — each device has its own Signal identity + prekeys registered under `(user_id, device_id)`; a sender fans out one ciphertext per recipient device (and their own other devices) in a `sig2` envelope. Gateway holds many concurrent connections per user so every device receives broadcasts. **Verified: a 2nd device of the same account decrypts new messages.**
- [x] **Group E2E (Sender Keys)** — Signal/WhatsApp group scheme: a per-member, per-group chain key ratcheted to a fresh AES-256-GCM key per message + an ECDSA P-256 signature so members can't forge each other. Sender keys distributed (Sender Key Distribution Messages) over the pairwise Signal sessions; the server only relays opaque ciphertext (`grp1.`). **Verified: 3-member group DM, one ciphertext, all decrypt, server blind.**
- [x] **Disappearing messages** — per-conversation TTL; messages carry `expires_at`, a background sweeper deletes them server-side (ciphertext doesn't linger) and a client timer drops them instantly. One-click duration picker + live banner. **Two-client verified: self-destruct with no reload.** (Also the engine for an account-level dead-man's switch.)
- [x] **Desktop key vault** (dazai/ningen-shikkaku) — on the desktop app, E2E private keys live in **page-locked, non-swappable RAM** (vendored `goodnight::SecretBuffer`), persisted only as an **AES-256-GCM sealed blob** (master key in the OS keychain) — never plaintext on disk like the old localStorage. An on-demand **burn** (wipe RAM + sealed blob + keychain key) is the dead-man's switch. Web build keeps localStorage (no mlock in a browser). *Vault core unit-tested; Tauri integration compiles; in-use keys still transit JS heap (full native crypto is a later phase).*
- [x] **Dead-man's switch (inactivity wipe)** — opt-in, cross-platform: if you don't open Ohiyo for N days (7/30/90), a server sweeper wipes your authored messages, and optionally your server-side Signal directory (scope = history / keys). Configurable in Settings → Privacy & Security. **Two-user verified: armed+inactive user's history wiped, others' survive.**
- [ ] Sealed sender (metadata hiding — needs sender certs + server trust-model change)
- [ ] Federation

## Design north star
Every surface should feel **intentional and alive**: smooth motion, real depth, presence
that makes the space feel inhabited. Reference, don't default. See the in-repo design
system (`client/src/index.css` tokens + motion) and the Daybreak brand.
