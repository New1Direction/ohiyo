# Ohiyo Discord Import — Design Spec

**Date:** 2026-06-17
**Status:** Approved design (pre-implementation)
**Author:** Brainstormed with Connor

---

## 1. North star

Let a community owner **bring their Discord server into Ohiyo in one click** and walk into a
**furnished room, not an empty server** — the same categories, channels, roles, and real
history they already have. The migration cost is the single biggest reason communities don't
leave Discord; this collapses it. The first run has to feel effortless and *flawless*,
because it is the first impression that lands bigger communities.

> "Bring your Discord server" is the on-ramp. The reason to stay is everything else Ohiyo is.

## 2. Problem

Switching platforms means abandoning years of structure and history, and asking everyone to
rebuild from scratch into an empty shell. People don't leave Discord because *export* is
hard — they leave when there's somewhere better to be — but even motivated owners stall at
"I'd have to recreate all 23 channels and lose every pinned message." A one-click import that
reproduces the server's bones and seeds its history removes that stall.

`discrawl` (`steipete/discrawl`) already solves the gnarly extraction half: a bot-token sync
that "discovers every guild a bot can access and syncs channels, threads, members, and message
history into SQLite," with attachments downloaded and FTS indexing. We inherit "correct at the
Discord boundary" instead of rebuilding pagination, rate-limit, and attachment handling
ourselves. What's missing is the **import** half: mapping that SQLite into Ohiyo.

### 2.1 Why v1 is deliberately scoped *down* (the risks we're respecting)

The full vision — a hosted, live, two-way bridge with claimable identities — has real ceiling
but concentrates risk at the worst moment. Four risks shaped this scope:

1. **Brand tension.** Ohiyo's pitch is "the server only ever holds ciphertext." Imported
   content is plaintext the server reads, stores, indexes, and re-serves. A *one-time archive*
   marked plainly as "not E2E" is honest and bounded; a *permanent live mirror of big
   communities* quietly dilutes the core differentiator. v1 is the bounded version.
2. **Rented land.** Mass-mirroring whole servers is what Discord discourages and can kill via
   bot ban or intent change. A one-time, owner-initiated import trips enforcement far less than
   a fleet of permanent live-sync bots.
3. **First-impression fragility.** "Bug-free" on Discord's API (forum/stage channels, threads,
   deleted users, large attachments, rate limits, partial data) is hard. A one-time job we can
   dry-run, resume, and make idempotent is far more controllable than a continuous bridge.
4. **Consent.** Importing copies hundreds of *members'* messages, names, and avatars. The owner
   authorizing the bot does not authorize on every member's behalf. v1 keeps imported content
   as a clearly-labeled archive (display-only ghost authors), not re-attributed live accounts,
   and surfaces this honestly.

## 3. The model: one-time, owner-authorized, structure + seeded history

The owner authorizes an Ohiyo bot into their Discord server **for the duration of one import
job**. We run `discrawl` to produce a SQLite mirror, map it into a **new Ohiyo space the
importer owns**, then discard the token. No permanent custody, no live sync.

Three guarantees mirror the Instant Servers ethos:

- **Bounded** — the bot token is used only for the import run, then dropped; the owner can kick
  the bot immediately after. We never hold a standing credential to their Discord.
- **Honest** — imported channels are visibly marked **"Imported from Discord — not end-to-end
  encrypted."** Native Ohiyo channels remain E2E; the import never weakens that boundary.
- **Transparent** — every import ends with a **report**: what mapped, what was parked, what was
  dropped, with counts. Nothing is silently lost.

## 4. What maps (Discord → Ohiyo)

| Discord | Ohiyo | Notes |
|---|---|---|
| Guild | New space (owned by importer) | One import → one space |
| Categories | Categories | Order preserved |
| Text channels | Channels | Name, topic, position |
| Threads | Threads-of-thought | Under their parent channel |
| Messages | Messages (read-only in archive) | Author, timestamp, content, replies |
| Attachments | Re-hosted in Ohiyo file storage | Downloaded by discrawl, re-uploaded |
| Reactions | Reactions | Custom emoji mapped where possible |
| Pinned messages | Pins | Preserved |
| Custom emoji | Custom emoji | Imported where they map |
| Roles | Roles (best-effort) | Name + color; permission bits mapped where they have an Ohiyo equivalent, rest noted in the report |
| Voice channels | Voice channels (structure only) | No history to import |

**Parked / dropped (listed in the report, never silent):** Discord-specific surfaces with no
Ohiyo equivalent — stickers, slash-command apps/integrations, stage channels (imported as a
note), forum-channel semantics beyond plain threads, fine-grained permission overwrites.

### 4.1 Identity — ghost authors (display-only in v1)

Each Discord author becomes a lightweight **ghost profile** (display name + avatar) so imported
history reads naturally and the space feels alive rather than like a dead log. Ghost profiles
are **display-only** in v1 — no login, no re-attribution. They are forward-compatible with a
future "claim your Discord identity" flow (Phase B), which would verify a real user via Discord
OAuth and re-attribute their imported messages — explicitly out of scope here.

## 5. Architecture

Three components. The extractor is external (discrawl); the importer and the connect flow are
new; everything downstream reuses today's server.

### 5.1 Connect flow (new, thin)

- **Bot invite** — "Add Ohiyo to Discord" → standard Discord OAuth2 bot-invite with read-only
  scopes + the **Message Content** privileged intent. Owner selects the guild and grants.
- **Preview** — before any write, run a discovery pass and show the owner a dry-run summary:
  "4 categories, 23 channels, ~18k messages, 340 members, ~2.1 GB attachments. Import?"
- **History depth** — the preview offers **All history** (default) or **Last 90 days**, a single
  timestamp filter so a very large, very old server isn't forced into a giant first import.
- **Authorization is per-job** — the token is scoped to this import and discarded on
  completion/failure; the bot can be removed by the owner immediately after.

### 5.2 Importer (new, the core of this work)

A backend job that consumes discrawl's SQLite and writes into Ohiyo:

- **Extract** — invoke discrawl (bot-token sync) → SQLite mirror + downloaded attachments. discrawl
  runs as a **one-shot containerized job** (isolation + resource caps; fits the Fly Machines setup).
- **Map** — translate Discord entities → Ohiyo entities per §4 into a **new space**.
- **Idempotent + resumable** — every imported row is keyed by its **Discord snowflake ID**;
  re-running the job upserts rather than duplicating, so a network blip or a manual re-run never
  doubles content and never corrupts a half-import.
- **Report** — emit the §3 transparency report as the final artifact.

The importer is a **bounded batch job**, not a long-lived service — it starts on owner action,
runs to completion (resumably), and exits.

### 5.3 Existing building blocks reused

Ohiyo's spaces/channels/messages schema, file storage, custom-emoji handling, and roles all
carry over — the importer writes through existing models rather than introducing parallel ones.

## 6. Data flow

- **Connect** — Owner clicks "Bring your Discord server" → OAuth bot invite → grant.
- **Preview** — Discovery pass → dry-run summary with counts → owner picks history depth (All /
  Last 90 days) → confirms.
- **Import** — Backend runs discrawl → importer maps into a new space → progress view fills in
  (channels appear, history streams) → completion → **import report**.
- **Cleanup** — Token discarded; owner prompted that the bot can now be removed from Discord.
- **Result** — A populated Ohiyo space the importer owns, with archive channels visibly marked
  "Imported from Discord — not E2E," ghost authors on history, and a report of what was parked.

## 7. Error handling & failure modes

- **Bot lacks access / missing intent** — preview step catches it before any write; clear
  "grant Message Content intent" guidance, never a half-import.
- **discrawl run fails midway** (rate limit, API error, network) — job marks `partial` and is
  **resumable**; snowflake-keyed upserts mean resuming continues where it stopped, no dupes.
- **Large server / long run** — import is a bounded batch with progress; attachments re-hosted
  streaming, not all-in-memory; owner sees live counts, never a silent hang.
- **Unmappable entities** — never fail the import; park them and record in the report.
- **Re-import of the same guild** — idempotent upsert by snowflake ID; safe to re-run to pick up
  what changed since, without duplicating history.
- **Token leak risk** — token held only in the job's memory/secret store for the run, never
  persisted to the space's data, dropped on exit.

## 8. Security & privacy

- **Per-job token only** — no standing Discord credential; discarded on completion/failure.
- **Honest E2E boundary** — imported channels are plaintext by nature and **labeled as such**;
  native Ohiyo E2E channels are untouched. The import path never writes into E2E channels and
  the existing E2E boundary suite must stay green.
- **Consent surfaced** — the importer documents (in product copy + the report) that imported
  content originates from Discord and is not member-consented per-head; ghost authors are
  display-only, not live accounts. A member data-removal path is an open question (§11).
- **No write-back to Discord** — v1 is read-only at the Discord boundary; nothing is posted into
  Discord, sidestepping webhook/impersonation and loop concerns entirely.
- **Attachment hygiene** — re-hosted attachments inherit Ohiyo's existing upload validation
  (type/size limits, SSRF-safe fetch path).

## 9. Testing strategy

- **Mapper unit tests** — each Discord entity → Ohiyo entity mapping (categories, channels,
  threads, messages, reactions, pins, roles), including parked/dropped cases land in the report.
- **Idempotency** — run the importer twice over the same fixture SQLite; assert zero duplicates
  and a stable result (snowflake-keyed upsert).
- **Resumability** — kill the job mid-run; resume; assert the final space equals a clean run.
- **Fixture-driven** — a committed sample discrawl SQLite (small synthetic guild) drives import
  tests with no live Discord dependency in CI.
- **Attachment round-trip** — discrawl-downloaded attachment → re-hosted in Ohiyo → renders.
- **Privacy regression** — imported channels are labeled not-E2E; existing E2E boundary suite
  stays green; no token persisted to space data.
- **e2e** — a new suite drives "connect (faked) → preview → import → archive space exists with
  history + report," matching the repo's `NN-*.test.mjs` harness.

## 10. Scope & build order

This spec is the architecture for v1 (Option A). Implementation decomposes into phases, each
getting its own implementation plan (via writing-plans):

1. **Importer core (offline).** Given a discrawl SQLite fixture, map it into a new Ohiyo space —
   structure + history + attachments + report. Idempotent + resumable. (No live Discord yet.)
2. **Connect flow + preview.** Discord OAuth bot invite, discovery/dry-run preview with counts,
   per-job token handling.
3. **Run orchestration + progress UX.** Wire discrawl execution behind the connect flow, the
   progress view, completion + cleanup prompt, the "not E2E" labeling and import report UI.

### Out of scope / YAGNI (v1) — this is where Option B lives

- **Live bridge / ongoing sync** (Discord → Ohiyo mirror after import).
- **Two-way cross-post** (posting from Ohiyo back into Discord via webhooks).
- **Claimable identity** (Discord OAuth → re-attribute ghost messages to real accounts).
- **Permanent hosted token custody** and the standing-bot infrastructure it implies.
- **discrawl's desktop "wiretap" / user-token paths** — never wired in; bot-token only.
- **Arbitrary date-range / per-channel history selection.** v1 ships exactly one coarse choice
  (All history / Last 90 days); finer-grained windowing is later.

We earn Option B only if communities ask for it *and* Discord doesn't slam the door.

## 11. Resolved decisions

These were open during brainstorming and are now decided for v1:

- **discrawl execution substrate:** a **one-shot containerized job** (isolation + resource caps;
  fits the Fly Machines setup), not an in-process subprocess on the control-plane host.
- **Member data-removal:** **delete-by-ghost-author** — one admin action removes all messages tied
  to a ghost profile. Simple, honest, sufficient for v1.
- **Custom emoji / reactions:** import custom emoji as **static images**; a reaction emoji with no
  Ohiyo equivalent keeps its **count with a fallback glyph** and a report note — never silent-drop.
- **Role permission mapping:** map the bits with clear Ohiyo equivalents (admin, manage
  channels/messages, kick/ban, mention-all); every other role is recreated **name + color** and
  flagged **"review manually"** in the report. Best-effort, never blocking.
- **Where the import lands:** a **new space per import** (deterministic, idempotent, no merge
  logic). "Import into an existing space" is deferred until a user actually asks.

### Still genuinely open (resolve during implementation)

- Exact discrawl invocation/version pinning and how the bot token is passed to the job's secret
  store for its single run.
