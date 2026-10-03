# Changelog

All notable changes to Ohiyo are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
Ohiyo follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — though while
we're pre-1.0, minor releases can still carry breaking changes.

Making a user-facing or security-relevant change? Add a line under **[Unreleased]** in
the matching category — see [CONTRIBUTING](CONTRIBUTING.md#changelog).

## [Unreleased]

### Added
- **Voice pre-join roster:** voice channels now show who is already in the call before
  you join, including a live count and compact participant preview.
- **Call entry preview:** joining a non-empty voice room now opens a “Ready to join?”
  panel with occupants, Join, Join muted, and Cancel.
- **Privacy polish:** the sidebar now shows a Privacy Mode badge when metadata privacy
  is enabled; encrypted attachment previews/messages show trust labels; empty channels,
  empty DMs, onboarding link entry, and the command palette now guide users toward the
  next private action.
- **Owner activation checklist:** new community owners now get a local-only launch
  checklist for account → first space → first message → invite → voice call, with
  clearer first-space onboarding that explains the seeded #general and voice room.
- **Instant Servers UX:** added a rail-accessible manager for create/list/use, sleep/wake,
  ownership-pack export, self-host graduation instructions, delete, and paid-tier billing
  handoff; backend lifecycle endpoints now support sleep, wake, export, graduate, and tier
  state with owner-scoped tests.
- **Push/mobile foundation:** added PWA manifest/service worker, Settings → Notifications,
  content-free push-device registration and relay queue APIs, offline-recipient enqueue on
  message send, notification privacy copy, and an APNs/FCM runbook for native mobile.
- **Reliability foundation:** added a public status page/API, hosted-community cost model,
  backup-restore drill script, status/alert check script, gateway/message load-smoke script,
  and reliability runbooks for backups, observability, alerting, and load testing.
- **One-command Discord template migration:** added an owner-authenticated template import
  endpoint and CLI script that reconstructs category/channel hierarchy, roles, best-effort
  permissions, overwrite snapshots, server icons, and custom emoji assets.
- **In-app Discord template move-in:** the Discord import wizard now accepts a template
  link directly and shows a permission-review gate with mapped roles, overwrite counts,
  imported emoji/assets, and a clear “review before inviting” warning.
- **Permission matrix audit:** imported Discord overwrite rows now have an owner/mod-only
  review API and in-app 1-2-3 audit view with exact allow/deny bitfields, decoded flags,
  manual-review reasons, asset provenance, and a safe invite checklist.
- **Grandma-readable migration review:** permission rows now include plain-English verdicts
  such as likely-private, read-only, can-see-and-chat, voice-room access, or powerful
  channel control, with a simple "do this before inviting" instruction.
- **Discord migration landing wedge:** the public landing page now advertises
  "Move your Discord community in one link" and routes admins to the app plus the
  migration guide.
- **Recovery backup v2:** personal recovery now writes a future-continuous, keys-only
  v2 backup envelope with per-entry device provenance, recovery-secret-derived blinded
  coverage handles, manifest-consuming restore preview, legacy v1 restore support, a v1
  refresh nudge, durable design notes, calmer protection-first copy, and first-class
  undecryptable-message states instead of a fake retry loop.

### Security
- **Permissions:** role hierarchy is now enforced when unassigning and deleting roles;
  the gateway's initial channel list and unread counts respect View Channel; kick, ban
  and leave clear the member's roles, member-level overwrites and voice seat.
- **Operator-only actions:** Discord imports that read local files or use the managed
  bot, and Instant Server tier changes, are limited to the accounts listed in
  `OHIYO_OPERATOR_USER_IDS` (unset means nobody). The local import reads media only
  from `OHIYO_DISCRAWL_MEDIA_ROOT`, and import asset URLs are fetched only from public
  addresses.
- **Rate limits:** limits are keyed on the real client address (`Fly-Client-IP` on Fly,
  `TRUSTED_PROXY_HOPS` behind other proxies) and IPv6 clients are counted by /64 and
  /48. Login is limited per username, registration to 10 new accounts an hour per
  address (`OHIYO_REGISTER_LIMIT_PER_HOUR`), and invite previews, prekey fetches and
  template imports have limits of their own. An account can hold 10 devices.
- **Abuse limits:** length caps on names, topics, bios, statuses and poll fields; the
  message list page size is clamped to 100; gateway frame size and sockets per user are
  capped and silent sockets are closed; password hashing runs off the async runtime
  with bounded concurrency; failed uploads no longer leave temp files behind.
- **Sessions:** "log out everywhere" now closes open gateway sockets and voids gateway
  tickets issued before it.
- **Outbound requests:** the link-preview and import fetchers refuse IPv4-mapped, NAT64,
  6to4, Teredo and other non-public addresses. Push dispatch accepts only known web
  push services and well-formed APNs tokens, with a timeout and no redirects.
- **Privacy Mode** now also covers read cursors and last-active times reported over
  REST, and the dead-man's switch no longer fires for users who are online.
- **Encryption (app):** a group message is never sent as plaintext when encryption
  fails; group message signatures are verified before the key ratchet advances;
  forwarding cannot carry decrypted content into the clear or plaintext into an
  encrypted chat; only DMs and group chats can enter encrypted mode; decrypted messages
  and encrypted chats show no link previews or embeds; encrypted attachment links must
  point at this home's file store; polls are hidden in encrypted chats because they are
  stored unencrypted.
- **Local data (app):** logging out clears the decrypted-message cache, the unsent
  outbox and drafts (keys are kept); drafts in encrypted chats stay in memory only;
  cached decrypted messages are dropped once they expire; a full browser storage no
  longer crashes the app.
- **Attachments:** files attached before a chat became encrypted are removed from the
  composer, and an encrypted chat refuses to send a file that was not encrypted.
- **Desktop vault:** a keychain or sealed-file failure now leaves the vault locked
  instead of starting an empty one that would overwrite the saved keys. The locked
  screen offers Try again and, when the saved keys cannot be opened, a confirmed reset.
  The sealed file is written atomically, and burning the vault restarts the app.
- **Calls:** call signalling is ignored unless you are in that call and the sender is
  one of its participants.
- **Plugins:** more network-capable APIs are removed from plugin workers, and plugin
  CSS containing escapes or anything that can make a request is rejected.
- **Web app headers:** Cloudflare Pages now sends `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, HSTS, `nosniff`, a referrer policy and a permissions policy.
- Message notifications respect the current blocked list.
- **Dependencies:** `jsonwebtoken` 10, `rustls`, `quinn-proto` and `event-listener`
  updated past their advisories; CI now runs `npm audit` and `cargo audit`.

### Changed
- Group encryption is now labelled **Experimental** in the app, with a note that it can
  miss messages sent while a member was offline.
- Deleting a message now also deletes its attachments when nothing else refers to them.
- Message history pages no longer skip or repeat messages created in the same second.
- "Activate paid" for Instant Servers is replaced by a disabled "Paid plan: coming soon"
  control until billing exists.
- The local Discord import no longer takes a media folder from the request, and import
  options your account cannot use are hidden.
- Profile and channel fields enforce the server's length limits, and rate-limit and
  device-limit errors show clear messages.
- Voice state join/leave/mute/video metadata now reaches everyone who can access the
  channel so the sidebar updates live; WebRTC signaling and voice encryption keys remain
  restricted to actual call participants.
- The public download page now includes a Mac beta FAQ explaining the current
  non-notarized Gatekeeper warning and recommending the browser app for the smoothest
  first run today.

### Fixed
- Production call smoke tests now skip the dev-only low-level peer-connection inspector
  while still verifying the live roster/UI behavior.

## [0.2.0] — 2026-06-22

Two headline themes: **import your community from Discord**, and a top-to-bottom
**security & quality hardening** pass (three review-and-fix rounds, ~75 findings, all CI
gates green). Upgrading needs no data migration; the only opt-in change is signed file
URLs (off by default — see **Added**).

### Added
- **Import from Discord.** A guided wizard imports a Discord server from an exported
  archive (Discrawl) — drag-and-drop with an automatic preview and explicit safety
  labels — or a managed "clone" flow that installs a bot and lets you pick the server.
- **Multiple homes.** Switch between Ohiyo servers (your own self-host, an Instant
  Server, a friend's box) at runtime, each with its own session.
- **Signed file URLs** behind the `OHIYO_REQUIRE_SIGNED_FILES` flag — HMAC capability
  URLs for `/files/…`. Default **off**; see [DEPLOY.md](DEPLOY.md) before enabling it on
  an existing deployment.
- **"Log out everywhere"** (`POST /auth/logout-everywhere`) — instantly revokes every
  session for your account.
- **Listen-only voice** — join a call to listen without a microphone.
- A tabbed DM messenger strip.
- This `CHANGELOG.md`.

### Security
- **End-to-end group messaging:** sender-key messages now use a random per-message IV
  (carried in the envelope) instead of a deterministic one — closing an AES-GCM
  nonce-reuse window on concurrent / cross-tab sends. Existing messages still decrypt.
- **Encrypted message edits**, and a fix for a role-assignment privilege escalation.
- **Authorization:** closed cross-server / cross-channel access bugs (event RSVPs, poll
  votes) and access-checked the typing indicator, voice join/meta, and watch-party
  controls.
- **Sessions & passwords:** per-request token-version revocation (powers "log out
  everywhere"); new password hashes use Argon2id.
- **Secrets at rest (desktop):** the session token, the decrypted-message cache, and the
  unsent-message outbox are sealed in the encrypted vault instead of plain local
  storage; recovery backups no longer include the session token.
- **SSRF / traversal / XSS:** the link-preview fetcher pins resolved IPs (DNS-rebind
  safe); Discord-import file paths are confined; profile, social, and in-chat links are
  validated through a single safe-URL guard; the plugin sandbox neutralizes more globals
  and blocks CSS injection.
- **Supply chain & infrastructure:** dropped the unused MySQL backend from sqlx, removing
  the `rsa` crate (RUSTSEC-2023-0071) from the build; the server container runs as a
  non-root user; added a `Permissions-Policy` header and an inbound WebSocket frame-size
  cap; the gateway recovers from poisoned locks instead of aborting the process.

### Changed
- Screen-share is now the primary in-call stage, with a polished in-call layout.
- Settings, the custom-appearance editor, and the voice sidebar got a polish pass.
- Internal Fly machine/volume IDs are no longer returned in instance API responses.
- Database: added indexes on `dm_participants(user_id)` and `files(uploader_id)` for the
  DM-list and upload-quota hot paths.
- macOS desktop downloads now require a notarized build (unnotarized downloads paused).

### Fixed
- Voice: mic playback and speaking indicators, the listen-only badge, screen-share
  teardown re-entrancy, and double-join connection leaks.
- Reliability: duplicate-message de-duplication, single-flight outbox retries, and
  WebSocket dead-connection detection + reconnect.
- Accessibility: the settings dialog gained proper dialog semantics + a focus trap, and
  the speaking indicator honors reduced-motion.
- Error boundaries around the call, plugin, and watch-party surfaces — plus many smaller
  correctness fixes across the gateway, imports, and React effects.

## [0.1.1] — 2026-06-16

Release and CI plumbing to unblock multi-platform desktop builds.

## [0.1.0] — 2026-06-14

Initial public, self-hostable release: servers, channels, DMs, threads, reactions, and
read receipts; Signal-protocol end-to-end-encrypted DMs and group chats (multi-device,
disappearing messages, safety numbers); WebRTC voice / video / screen-share; a sandboxed
plugin system; the Daybreak and Dusk themes; and a Tauri desktop app.

[Unreleased]: https://github.com/New1Direction/ohiyo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/New1Direction/ohiyo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/New1Direction/ohiyo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/New1Direction/ohiyo/releases/tag/v0.1.0
