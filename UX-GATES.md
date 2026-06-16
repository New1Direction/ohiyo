# Ohiyo UX Gates — world-class messaging checklist

The bar for a messaging app people *love* isn't features — it's feel. These are the
gates, scored honestly against the current build. **Legend:** ✅ meets the bar ·
🟡 partial / good-on-desktop · ❌ not built yet.

| # | Gate | Status | Where we stand |
|---|------|--------|----------------|
| 1 | **Send feels instant** (<100 ms local) | ✅ | Optimistic `temp-` messages render immediately on send and reconcile on the gateway echo. Effectively instant. |
| 2 | **Input never janks** | 🟡 | Composer is a plain controlled input — no jank on desktop. No soft-keyboard coordination needed until mobile. |
| 3 | **Scroll never betrays** | ✅ | **Fixed.** Auto-scrolls to the latest only when you're already at the bottom (or on your own send / channel switch). Read history undisturbed; a new message surfaces a **"↓ New messages"** pill instead of yanking. (Two-user verified: no jump + pill.) History-prepend anchoring N/A until infinite-scroll-up exists. |
| 4 | **Every message has a clear state** | ✅ | **Fixed.** Optimistic message renders **dimmed (pending)** → **sent** on echo, or **failed** with an inline **Retry / Delete** affordance if the send errors (no silent vanish). e2e-locked (`14-failed-retry`). Delivered/read receipts still future. |
| 5 | **Media never causes layout shift** | ✅ | **Fixed.** Server records image pixel dimensions at upload (`imagesize`); the client reserves the exact aspect-ratio frame with a soft placeholder before the image loads, and `estimateHeight` uses real dimensions (also kills the last scroll-jump source). Also fixed a latent bug: attachments were never parsed (returned as a JSON string), so images never actually rendered. e2e-locked (`15-images`). ThumbHash blur-up is an optional future nicety. |
| 6 | **Composer is sacred** | 🟡 (improved) | **Per-channel text drafts now ship** (e2e-tested: no leak, restored on return), and cursor is preserved. Still TODO: per-channel **attachments + reply target** (reply is currently just cleared on switch). |
| 7 | **Offline-first queue** | ✅ | **Fixed.** Unsent messages persist to a localStorage **outbox** (`lib/outbox.ts`), survive channel switches and reloads (merged back per channel), and **auto-flush** when connectivity returns (browser `online` event + gateway reconnect). e2e-locked (`16-outbox`). Caveat: no server idempotency key yet, so a send the server accepted but whose response was lost can re-send once on flush. |
| 8 | **Presence is smoothed** | 🟡 | Typing is debounced server-side (2.5 s cooldown) + client TTL (5 s) — not flickery. Online/offline via gateway. No read receipts yet. |
| 9 | **Touch has physics** | ❌ (deferred) | Swipe-to-reply / long-press / spring / haptics are **mobile** concerns. Current target is the Tauri desktop app; revisit when a mobile build lands. |
| 10 | **Low-end hardware is first-class** | 🟡 | Lightweight by construction (small bundle, Rust backend, virtualized message list, CSS motion with `prefers-reduced-motion`). Not yet profiled on low-end devices. |

## Recently shipped
- **Message list redesign** — persistent per-message action rows → Discord-style **floating hover toolbar**; tight author-grouping; reactions only when present; **hover-gutter timestamps**.
- **Server-rail hover** (squircle + accent tint) to match the existing active-pill indicator.
- **Gate 6: per-channel drafts** (composer is sacred) — e2e-locked (`13-drafts`).
- **Gate 3: scroll anchoring** — near-bottom auto-follow + "↓ New messages" pill (two-user verified).
- **Gate 4: message state machine** — pending (dimmed) → sent / failed + Retry — e2e-locked (`14-failed-retry`).

## Scorecard now
✅ **1, 3, 4, 5, 6, 7** · 🟡 **2, 8, 10** (good on desktop) · ❌/deferred **9** (mobile).

## Priority order for the next passes
1. **Gate 9 — Touch physics** (DEFERRED). With the mobile build (swipe-to-reply, long-press, springs, haptics).
2. **Polish remainders.** Header + composer icon restyle; broader hover/active audit (modals, voice overlay).
3. **Hardening nice-to-haves.** ThumbHash blur-up (gate 5), server idempotency key so outbox flush can never duplicate (gate 7), per-channel attachments/reply (gate 6), read receipts (gate 4/8).

## Visual polish still open (from the earlier diagnosis)
- Header + composer icon refinement (#4 of the visual list) — functional, not yet restyled.
- Broader hover/active-state audit across modals and the voice overlay.
