# Launch hardening plan (2026-10-03)

**Spec:** the review at `/Users/clubpenguin/Documents/ohiyo-review-2026-10-03/REVIEW.md` (finding IDs such as S-H2 and C-H1 refer to it). Read the entry for each finding you implement; it has the evidence and the file references.

**Goal:** fix what stands between v0.2.0 and a public launch: permission bugs, data loss, plaintext leaks from encrypted chats, cheap denial of service, vulnerable dependencies, and documentation that promises more than the code does. Large redesigns (device trust, group sender-key rework, encryption on by default, password reset) are out of scope and are documented instead.

## Global Constraints

- Work only in `/Users/clubpenguin/Documents/Projects/oHiYo` on the branch `launch-hardening`. Never push, never switch branches, never touch `main`, never amend or rebase existing commits.
- Stage explicit paths only. Never `git add -A`, `git add .` or `git commit -a`. Leave the untracked file `ohiyo-launch-checklist.html` alone.
- One commit per fix (or per tightly related group of fixes). Message format `<type>: <description>` with type one of fix, feat, test, docs, chore, perf, ci, and the finding ID in the description, for example `fix: enforce role hierarchy on unassign and delete (S-H2)`. No co-author or attribution lines.
- Test first. For every fix write the failing test, run it and see it fail for the right reason, then fix. Record in your report how you saw each test fail. A fix with no test that fails without it is not done.
- Smallest change that fixes the finding. No refactors, renames, reformatting of untouched code, new dependencies or new features beyond what a task states. Match the surrounding style.
- Never weaken, skip or delete an existing test to make it pass. If an existing test encodes the old (wrong) behaviour, change it and say so in the report.
- Do not contact production or any live Ohiyo endpoint. Network access is for crates.io and the npm registry only.
- **The disk is nearly full.** Server builds must run with `CARGO_TARGET_DIR=/private/tmp/claude-501/-Users-clubpenguin/52051fd6-aaf0-40fd-bdbc-183d3a6daaed/scratchpad/probe/server/target` (an existing build cache). Check `df -m ~` before long builds; if free space falls under 1000 MB, stop and report BLOCKED. Do not create extra build directories.
- Server gates, from `server/`: `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. All must pass before you report.
- Client gates, from `client/`: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run build`. All must pass before you report.
- If an item turns out to be unsafe or much larger than described, leave that item undone, finish the others, and report it under Concerns with what you found. Do not guess.

---

## Task 1: Server authorization, privacy and data-safety fixes

Files are under `server/src` unless noted. Add integration tests under `server/tests` in the style of the existing ones (see `tests/channel_permissions.rs`, `tests/common`).

1. **S-H2, role hierarchy.** `api/roles.rs`: `delete_role` (about line 347) and `unassign_role` (about line 454) check only `MANAGE_ROLES`. Require `member_top_position(actor) > role.position` in both, exactly as `assign_role` does (about line 423), keeping the owner exception that `assign_role` relies on. For `unassign_role` also require the target member's top position to be below the actor's unless the actor is the target. Tests: a moderator with `MANAGE_ROLES` gets 403 when unassigning or deleting a higher role, and 204 for a lower one.
2. **S-H3, hidden channels in `Ready`.** `gateway/mod.rs` (about lines 1139-1156 and 1185-1207): the `Ready` payload must list only channels the user can view, using the same permission path as REST (`fetch_full_for_user` / `list_channels`), and the unread map must contain only those channels. Test over the gateway: with an `@everyone` deny on a channel, `Ready` contains neither the channel nor an unread entry for it.
3. **S-M8, Privacy Mode over REST.** `api/messages.rs` `list_reads` (about lines 590-615) must omit read cursors of users who have Privacy Mode on (the requester always sees their own). `api/profile.rs` (about lines 214-231) must return `last_active_at: null` for a Privacy Mode user to anyone but themselves. Use the same preference the gateway already consults when it suppresses the Seen event.
4. **S-M10, stale state after removal.** `api/servers.rs` `remove_member` and `leave_server` (about lines 183-280), and the ban path: delete the member's `member_roles` rows for that server in the same transaction. Evict the removed user from that server's voice rooms in `state.voice`. `api/messages.rs` `distribute_voice_key` (about lines 1081-1123) must re-check channel access for the recipient, as the signal relay does. Test: kick, rejoin by invite, permissions are the default member's.
5. **S-M15, instance tier.** `api/instances.rs` (about line 171) / `provision/mod.rs` (about line 272): changing an instance's tier requires the caller's user id to be listed in the comma-separated env var `OHIYO_OPERATOR_USER_IDS`. Unset means nobody. Everyone else gets 403. Put the operator check in one small helper; Task 3 reuses it.
6. **S-H5, dead-man's switch.** `api/users.rs` `sweep_deadman` (about lines 874-904) must skip any user who has a live gateway session in `state.sessions`. `gateway/mod.rs`: `ClientEvent::Heartbeat` (about line 748) must call `touch_active`, at most once per 60 seconds per connection. Test: a user with an armed switch, a stale `last_active_at` and a live session keeps their messages; the same user with no session loses them.
7. **S-M9, attachments outlive their message.** When a message is deleted (`delete_message`, about `api/messages.rs:903`), expires (`sweep_expired`, about line 1128) or is wiped by the dead-man sweep, delete each attached `files` row and its blob **only if** nothing else references that file: no other message attachment, no avatar, banner, server icon or emoji. Upload dedup means several messages can share one file id, so count references. Do the database delete first and the blob delete after commit. Tests: sole reference is removed and `/files/{id}` returns 404; a file shared by two messages survives the first delete and goes with the second. If the schema cannot tell you every place a file is referenced, stop on this item and report it.

---

## Task 2: Server input limits, resource limits and abuse controls

Files are under `server/src`.

1. **S-H1, length caps.** Add one validation helper and use it at every write: display name at most 64 characters (`api/auth.rs` about line 98, `api/profile.rs` about line 239); server name 100; channel name 100; channel topic 1024; role name 100; event title 200 and description 4000; poll question as in item 4. Count characters, not bytes; reject with 400. Existing rows are not migrated.
2. **S-H4, upload temp files.** `api/files.rs` (about lines 125-162): every exit path must remove the temp file; use a drop guard that is disarmed on the success rename. On startup, delete `tmp-*` files in the upload root older than one hour. Test: an upload that fails mid-body leaves no `tmp-*` file.
3. **S-M6, list limit.** `api/messages.rs` about line 106: `q.limit.clamp(1, 100)`. Check every other handler that takes a `limit` and apply the same lower bound.
4. **S-M7, polls.** `api/polls.rs` (about lines 81-190): the question obeys the same byte cap as a normal message (4000), each option is at most 200 characters with at most 10 options, the sender/recipient block check that `send_message` applies also applies, and in a channel with disappearing messages the poll message gets the same `expires_at` a normal message would. Polls remain allowed in DMs.
5. **S-M11, WebSocket limits.** `gateway/mod.rs` `ws_handler` (about lines 278-291): set `max_message_size` and `max_frame_size` to 256 KiB. Cap live sockets per user at 20; a new connection over the cap is refused. `logout-everywhere` must close the user's live sockets.
6. **S-M3, password hashing off the executor.** `api/auth.rs` (about lines 95 and 152): run Argon2 hash and verify inside `tokio::task::spawn_blocking`, behind a semaphore of 4 permits.
7. **S-M12, indexes.** New migration (next number in `server/migrations`) adding indexes on `messages(reply_to)`, `messages(author_id)`, `hidden_messages(message_id)`, `saved_messages(message_id)` and `abuse_reports(message_id)`, each `IF NOT EXISTS`. Skip any that already exists under another name.
8. **S-M14, pagination tiebreak.** `api/messages.rs` `list_messages` (about lines 111-125): accept an optional `before_id` query parameter. When both `before` and `before_id` are present, page on `(created_at, id) < (before, before_id)` and order by `created_at DESC, id DESC`. Without `before_id` the old behaviour stays. Test: six messages in one second, page size two, walking with `before` + `before_id` returns all six exactly once. (The client change is in Task 4.)
9. **S-M1, SSRF guard.** `api/og.rs` `is_public_ip` (about lines 14-28): convert IPv4-mapped IPv6 with `to_ipv4_mapped()` before checking, and also treat 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 240.0.0.0/4, multicast and the IPv6 unique-local, link-local and documentation ranges as not public. Unit-test each range.
10. **S-M2, rate-limit keys.** `api/auth.rs` client IP resolution (about lines 25-39): trust `fly-client-ip` only when the `FLY_APP_NAME` env var is set; trust `x-forwarded-for` only when `TRUSTED_PROXY_HOPS` is set to N, taking the Nth address from the right; otherwise use the socket peer address (add `ConnectInfo` if the server does not already pass it). Key IPv6 clients by their /64. Add a per-username login limit of 10 per minute alongside the per-IP one. `ratelimit.rs`: bound the key map so a flood of distinct keys cannot grow it without limit or make every call O(n).
11. **S-M4, invite preview.** `api/invites.rs`: rate limit `GET /invites/{code}` to 30 per minute per user and per client IP. New invite codes are 12 characters; existing codes keep working.
12. **S-M5, prekeys.** `api/signal.rs` (about lines 152-224): rate limit prekey-bundle fetches to 30 per minute per caller and 60 per minute per target user; pop the one-time prekey atomically with `DELETE ... RETURNING`; `publish_keys` refuses more than 10 devices per user.

---

## Task 3: Server push dispatch, import gating and dependency updates

1. **S-H8, push dispatch.** `server/src/api/push.rs` (about lines 213-275, 460, 569-586) and the sweeper loop in `server/src/main.rs` (about lines 36-65).
   - A `platform=web` endpoint must be an `https` URL whose host is one of: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, any `*.push.services.mozilla.com`, any `*.notify.windows.com`, `web.push.apple.com`, any `*.push.apple.com`. Anything else is rejected with 400 at registration and skipped at dispatch.
   - The dispatch HTTP client has a 10 second timeout and follows no redirects.
   - Dispatch runs in its own task so `sweep_expired`, `sweep_deadman` and link garbage collection never wait on it.
   - An APNs device token must be hex only; reject anything else.
2. **S-H6 and S-H7, imports are operator-only.** `server/src/api/discord_import.rs`, `server/src/import/`.
   - Every local Discrawl import route and every managed Discord import route (guild list, jobs, run) requires the caller to be in `OHIYO_OPERATOR_USER_IDS` (the helper from Task 1), in addition to the existing feature flags. Unset means nobody; others get 403.
   - Local import ignores any client-supplied `media_root`. The root comes from the env var `OHIYO_DISCRAWL_MEDIA_ROOT`; a media path is used only if its canonical form is inside the canonical root.
   - `import/assets.rs` (about lines 31-48): archive-supplied URLs are fetched with a 10 second timeout, no redirects, the public-IP check from `api/og.rs`, and a streaming 10 MiB cap.
   - `POST /imports/discord/template` stays open to all users but is limited to 3 per hour per user.
3. **O5, dependencies.** In `server/`: `cargo update -p rustls -p quinn-proto -p event-listener` (or the smallest set of updates that moves them past the advisories in the review). Upgrade `jsonwebtoken` to 10.3 or later using its `rust_crypto` feature; keep HS256-only validation and the required `exp` check exactly as today, and keep every existing auth test passing. `rsa` has no fixed release; leave it and say in the report which dependency pulls it in and whether it is compiled.

---

## Task 4: Client encryption correctness and leaks

Files are under `client/src`. Add unit tests under `client/test` in the style of the existing ones; pull logic into small pure functions where that is what makes it testable.

1. **C-H1, no plaintext fallback in groups.** `App.tsx` (about lines 1327-1345, 1504-1506, 1556-1563, 1630-1633). Keep one in-flight sender-key distribution promise per channel and await it before encrypting. If `groupEncrypt` returns null on send, edit or retry, throw so the message lands in the existing failed state with Retry; never send the plaintext and never fall back to the one-to-one path for a group. A failure inside `distributeMySenderKey` must surface the same way.
2. **C-H2, no link previews for encrypted messages.** `components/ChatPane.tsx` (about lines 1608, 2215-2237, 2257, 2316-2327). For a message that was decrypted on this device (`msg._encrypted`, or any message in a channel in encrypted mode) render no `LinkPreviewCard`, make no `/og` request and auto-load no YouTube iframe. Links stay clickable.
3. **C-H4, verify before ratchet.** `lib/senderKeys.ts` `groupDecrypt` (about lines 260-280). Verify the ECDSA signature before advancing the chain. Refuse to ratchet more than 2000 steps ahead of the stored iteration and return null. Reject a non-integer or negative `it`. Tests: `it = 4e9` returns null in under 100 ms; a bad signature does not advance state.
4. **C-H6, entering encrypted mode.** `App.tsx` `decryptMessages` (about lines 1350-1370). Mark a channel encrypted only when its type is `dm` or `group_dm` **and** at least one message in it actually decrypted. Never do it for a server channel. Choose the one-to-one peer from the channel's participant list, not from message authors. Unparseable ciphertext-looking content is shown as an undecryptable message and changes nothing else.
5. **C-M4, stop burning prekeys.** `lib/signal.ts` `encryptFor` (about lines 381-405). Do not call `getPrekeyBundles` for a user when sessions already exist for every device known for that user, unless the device list for that user has not been refreshed in the last 10 minutes.
6. **C-M7, encrypted attachment URLs.** `lib/encryptedPayload.ts` (about lines 41-64) and `components/ChatPane.tsx` (about lines 354, 2646-2651, 2881-2882). Accept an attachment `url` only if it is a `/files/<id>` path on the current home; drop the attachment otherwise. The decrypted Blob's type comes from an allowlist of image, video, audio, PDF and plain-text types; anything else is `application/octet-stream`.
7. **Polls in encrypted chats.** `components/ChatPane.tsx` (about line 1862): hide the poll button when the channel is in encrypted mode, because a poll is stored unencrypted.
8. **Group encryption is labelled experimental.** Where the encryption toggle and the encrypted banner are shown for a `group_dm`, add the word "Experimental" and one sentence: "Group encryption can miss messages sent while you were offline."
9. **S-M14 client half.** When loading older messages, send `before_id` (the id of the oldest loaded message) together with `before`. See `api.ts` and the caller in `App.tsx`.

---

## Task 5: Client local data safety, plugin sandbox, headers and build dependencies

1. **C-H8, vault key loss.** `client/src-tauri/src/vault.rs` (about lines 45-49, 70-102).
   - Only a "no entry" answer from the keychain creates a new master key. Any other error must not generate or store a key: the vault reports itself locked and the app surfaces that state instead of starting with an empty vault.
   - A failed `Vault::open` must not be replaced by an empty vault that later overwrites the sealed file.
   - Write the sealed file atomically: write a temp file in the same directory, fsync, rename.
   - Put the decision logic where it can be unit-tested without a real keychain (a small function taking the keychain result). Compiling the full Tauri crate needs disk space that may not be there: try `cargo check` in `client/src-tauri` with the shared `CARGO_TARGET_DIR` only if `df -m ~` shows more than 2500 MB free, and say in the report whether it compiled.
2. **C-M2, logout.** `client/src/App.tsx` `handleLogout` (about lines 162-165): on logout remove the decrypted-message cache (`kc:e2e-pt:*`), the outbox and all drafts. Keep identity and session keys.
3. **C-M3, local plaintext.** Drafts for a channel in encrypted mode are kept in memory only, never in localStorage (`components/ChatPane.tsx` about lines 28-37). `lib/e2eCache.ts`: store each entry's `expires_at` and drop expired entries when the cache is read.
4. **C-M6, storage and locking.** Guard the `localStorage.setItem` inside the `setE2eChannels` updater (`App.tsx` about line 1362) and the Signal store `put` (`lib/signal.ts` about lines 101-103) so a quota error cannot crash rendering; on quota failure evict the plaintext cache and retry once. Wrap `initSignal` and `publish` (`lib/signal.ts` about lines 211-262) in a `navigator.locks` lock where available.
5. **C-M8, call signalling.** `App.tsx` (about lines 1112-1114) / `hooks/useWebRTC.ts` (about lines 275-326): ignore a `VoiceSignal` unless the user is in a call on that channel and the sender is a current participant of that call.
6. **Blocked users and notifications.** `App.tsx` (about lines 693-701, 1694-1706): `maybeNotify` must read the current blocked list (a ref), not the first render's.
7. **C-H7, plugin sandbox.** `client/src/plugins/sandbox.ts` (about lines 100, 146-159).
   - Add to the removed globals: `WebSocketStream`, `WebTransport`, `EventSource`, `RTCPeerConnection`, `RTCDataChannel`, `BroadcastChannel`, `SharedWorker`, `Worker`, `importScripts`, and `navigator.sendBeacon`, alongside what is already removed.
   - `sanitizePluginCss` must reject (return an empty string for) any stylesheet that contains a backslash, `@import`, `url(`, `image-set(`, `-webkit-image-set(`, `src(`, `expression(` or `@font-face`, matched case-insensitively after removing comments.
   - Unit tests cover each bypass listed in the review (`u\72l(`, `\75rl(`, `image-set`, `-webkit-image-set`).
8. **O4, response headers.** Add `client/public/_headers` for Cloudflare Pages with, for `/*`: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), payment=()`. Do not add microphone, camera or display-capture restrictions; calls need them. Confirm the file lands in `client/dist` after `npm run build`.
9. **O7, npm advisories.** In `client/`: `npm audit fix` without `--force`. Report what remains.
