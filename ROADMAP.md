# Kikkacord Roadmap — the hub for doing things together

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
- [x] LiveKit **client engine** — drop-in `useWebRTCLiveKit`, flag-gated + lazy-loaded *(built/typechecked; a live multi-party call needs a running LiveKit to verify end-to-end)*
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

## Foundations (cross-cutting)
- [x] Rust (axum + sqlx/SQLite) server, React 19 + Tauri client, **Daybreak**/Dusk design
- [x] Quality gate: ESLint (a11y as errors), tsc, cargo test, 18-suite e2e, GitHub Actions CI
- [x] **AGPL-3.0** licensed; adversarial security review pass (SSRF / XSS / injection / JWT)
- [x] Presence **snapshot on connect** (see who's online + their activity the moment you open the app)
- [ ] Multi-node scale: NATS/Redis gateway fan-out, Postgres option
- [ ] Mobile build (Tauri mobile); push notifications
- [ ] Federation + E2E encryption (the things incumbents *won't* do)

## Design north star
Every surface should feel **intentional and alive**: smooth motion, real depth, presence
that makes the space feel inhabited. Reference, don't default. See the in-repo design
system (`client/src/index.css` tokens + motion) and the Daybreak brand.
