# Changelog

All notable changes to Ohiyo are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
Ohiyo follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — though while
we're pre-1.0, minor releases can still carry breaking changes.

Making a user-facing or security-relevant change? Add a line under **[Unreleased]** in
the matching category — see [CONTRIBUTING](CONTRIBUTING.md#changelog).

## [Unreleased]

### Added
- **ohiyo.gg has a Download section** for the desktop app, with the steps to open the Mac beta.

### Changed
- **The app's typefaces ship with it.** Inter, Sora and Geist Mono used to load from Google
  Fonts, which held back the first paint and showed Google the IP address of everyone who
  opened Ohiyo. The web and desktop content policies no longer allow Google's font hosts.

## [0.3.0] — 2026-10-12

### Added
- **Desktop app for Mac and Linux:** it can stay in the tray when you close the window, so
  notifications keep arriving (on by default on Mac, a setting on Linux), with the unread
  count on the Mac dock icon and a tray menu (open, leave call, check for updates, open at
  login, quit). The official builds offer their own updates and install one when you say
  so; a copy you build yourself never looks. On Mac it asks for the microphone and camera properly,
  so voice can work. It talks to the current server; 0.2.0 still pointed at the old one
  and has to be replaced by hand once. Mac builds are a beta that Apple has not verified.
  Windows is not included yet.
- **Delete your account**, under Settings → Account. It needs your password and your
  username typed out, and it happens at once. Every message you sent is deleted, for
  everyone. A space you own goes to its longest-standing member, or is deleted if nobody
  else is in it; a group you own goes to the next member. Instant Servers you run are shut
  down. Your encryption keys and recovery backup are deleted on the server and on that
  device. Emoji you added to someone else's space, and pictures others still use, stay.
- **You're told when a new device signs in to your account.** Every device has its own
  encryption keys, and people encrypt a copy of each message for each one. So someone
  with a stolen session could add a device and quietly read everything sent to you after
  that. Your other devices now say so the moment it happens, or the next time you open
  them. "It was me" keeps it; "Not me" takes it off your account and signs out every
  session, that one included.
- **Sign out everywhere**, under Privacy & security → Linked devices. Ends every session
  of your account, on this device too. The server could already do this; nothing in the
  app asked it to.
- **A contact's new device is announced in your chat.** Each of their devices can read
  what you send, and a new one used to be trusted without a word. Now the chat says
  "They added a new device." If you had verified them, it's a loud warning instead, and
  the verified mark comes off until you compare safety numbers again: verified now means
  the devices you actually compared, not whatever they add later.
- **Change your password**, under Settings → Account. It needs your current password, and
  it signs you out everywhere else, so someone who knew the old one, or copied a session,
  is out. The device you change it on stays signed in. Your encryption keys and recovery
  backup don't use the password, so nothing else needs redoing.
- **Leave a space, or delete it if it's yours.** The ⋯ button beside a space's name has
  "Leave space" for members and "Delete space" for the owner, which asks for your password.
  The app had neither before.
- **YouTube videos and posts on X play in the chat:** a YouTube link shows the video's picture
  with a play button; press it and the video plays right there, from the moment the link points
  at. A link to a post on X opens the post in the chat, sized to fit. No player is loaded
  from YouTube or X until you press the button (outside encrypted chats the video's picture
  is, to draw the card), each card has a Close button, and leaving the chat closes them. It
  also works in end-to-end encrypted chats: there the card is a plain button with no picture
  or title, and nothing at all is fetched before the press. The app's security policy now
  allows frames from exactly two places, YouTube's player and X's post frame.
- **Dream room lighting and gestures:** an outside-only live compositor halo where supported, lighter mode controls, local volume by sliding the right surround, and host double-click/tap playback. Provider controls stay uncovered; unsupported mobile volume uses device controls.
- **Watch-party viewing modes:** Dream feathers the video edges into a softened room;
  Cinema opens a black fullscreen view with thin top/bottom insets. Both keep the
  existing player and playback state, with accessible mode controls.
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
- **Encryption trusts only the devices you can see.** A message is encrypted only to the
  devices in the other person's device list, under the key listed there, which is the same
  list their safety number and "They added a new device" come from. So the server can't
  slip in an extra reader, and if the list can't be fetched the message isn't sent. A
  message from a device that isn't on the list raises the new-device notice instead of
  showing as normal, and the first encrypted-DM format, which the server could forge, is no
  longer opened. Removing a device gives your group chats new keys, so it can't read what
  is sent after.
- **Signing out everywhere ends everything a stolen session left behind.** "Sign out
  everywhere", "Not me" and a password change now also cancel any device-link code still
  waiting, and stop push notifications to devices whose session has ended.
- **Lasting changes ask for your password:** deleting a space, replacing or deleting your
  recovery backup, and changing the dead man's switch. Wrong guesses are limited to 5 a
  minute.
- **The new-device alert is harder to miss.** It is checked again whenever the app
  reconnects, so a device added while your laptop slept is still flagged; a second tab can
  no longer erase it; it shows when the device was added, not when you noticed; and "Not me"
  removes the device and signs everyone out before it forgets the device, so a failure can
  be retried.
- **The dead man's switch ignores our outages.** Time the server was down no longer counts
  against you, and a switch that has fired doesn't fire again.
- **A block also stops group chats:** someone you blocked can't add you to a group chat,
  and you can't add them.
- **Deleting a channel or a space deletes its files** (attachments, custom emoji and the
  space's icon), and links to them stop working.
- **Saved shows only messages you can still see.** Leave a space or lose access to a
  channel, and its messages leave your Saved list.
- **One account can't swamp everyone else:** presence, activity, voice state, watch-party
  controls and group encryption keys are rate-limited; an account keeps its 10 most recent
  push devices; a device holds at most 500 one-time keys, published at most 30 times a
  minute; and an account gets at most 60 connection tickets a minute.
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
- **Abuse limits:** length caps on names, topics, bios, statuses, profile and poll
  fields; a message carries at most 10 attachments; the message list page size is
  clamped to 100; gateway frame size and sockets per user are
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
  point at this home's file store; polls and watch parties are hidden in encrypted
  chats because they are not encrypted; a decrypted message cannot be edited while the
  lock is off.
- **Local data (app):** signing out of the last account on a device asks first, then
  clears the decrypted-message cache, the unsent outbox and drafts (keys are kept); the
  same data is cleared when a different account signs in there, and kept when a session
  simply expires. Drafts in encrypted chats stay in memory only; cached decrypted
  messages are dropped once they expire; a full browser storage evicts the oldest
  cached messages instead of crashing the app.
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
- **A new sign-in screen.** A painting fills the screen and follows your local time:
  sunrise, morning, the meadow in the afternoon, sunset, and a starry night with fireflies.
  It greets you to match ("Good morning.", "Good evening.", "Still up?"). The fields sit
  straight on the scene with no card around them, the long note about forgotten passwords is
  tucked behind one line, and the whole form fits the desktop app's window without scrolling.
- **The client installs with Bun.** `client/bun.lock` replaces `package-lock.json`, and CI,
  the release build, the web app's Docker image and the Tauri dev/build hooks use Bun to
  install packages and run scripts. Node still runs `tsc`, ESLint, Vite and the unit tests.
  Contributors need [Bun](https://bun.sh) 1.4+ alongside Node 22.
- **Dependency updates.** The server moves to tokio 1.53, serde_json 1.0.151, futures
  0.3.34, flate2 1.1.10 and uuid 1.27. The release build uses tauri-action v1 (same
  inputs, now on Node 24; it still uploads the updater's `latest.json` and leaves the
  release a draft), and the watch-modes check uses setup-node v7 and upload-artifact v7.
- **Restoring keys warns you first.** A restore makes this device take the place of the
  device that made the backup. If both keep being used, encrypted messages can stop
  decrypting on both. The restore box now says so, and points to Link a device when the
  old device still works.
- **The desktop app is on Tauri 2.12.** The Rust crates and the `@tauri-apps` npm packages
  moved together (autostart 2.7, updater 2.13, deep-link 2.6, notification 2.6, opener
  2.7), because the Tauri CLI refuses a build where a plugin's crate and npm package are on
  different minors. Nothing the app does changes.
- **Usernames are the same in any case, and use a fixed set of characters.** For new
  sign-ups, "Alice" and "alice" are the same name, and a name can use letters, numbers,
  dots, dashes and underscores. The sign-up form says so before you submit. You can sign in
  with your name in any case. Existing names keep working as they are.
- **Uploads: 1 GB per account,** down from 10 GB (`MAX_UPLOAD_BYTES_PER_USER` changes it).
  Uploads also stop while the server's disk has less than 5 GB free
  (`MIN_FREE_DISK_BYTES`; 0 turns it off), so the database always has room to write. A
  refused upload, including a picture or emoji, now says why. Running out says how much
  space you have and that deleting messages with files you no longer need makes room.
- **Plain words for signing out and deleting.** The app no longer says "session". The list
  of what deleting your account does now covers group chats, one-to-one chats (they show
  "Deleted account") and your username (free for anyone again). After a deletion the app
  says calmly what it knows.
- **Red buttons and red text are readable in every theme** (custom themes get a "Danger
  button" colour in the theme editor), and the new-device alert's answers are big enough for
  a finger. Delete account puts the cursor in the password field, and "Not me" and "Sign out
  everywhere…" move keyboard focus to their question and back on Cancel.
- **DMs show who they're with.** After a reload a 1:1 chat used to be called "Direct
  Message"; it now shows the person's name, picture and online dot. A new DM appears in
  the other person's list at once. Deleting your account fits a phone screen.
- **Outage alerts can go to a phone.** The reliability check posts plain text with a title
  to an ntfy topic (`ALERT_WEBHOOK_URL=https://ntfy.sh/<topic>`), and Slack or Discord
  webhooks now get real line breaks.
- **ohiyo.gg has a new first screen:** one painting, edge to edge. A sunlit meadow with the
  Ohiyo mark as a stone sculpture and Kikka sitting beside it, with the headline, one line of
  description and the two buttons on the sky at the left. Leaves drift across, butterflies and
  far-off birds move, and the sun glows. On tablets and phones the words come first and the
  sculpture and Kikka sit below them. The app screenshots moved to just under the first
  screen, and the link preview picture (the card shown when ohiyo.gg is shared) uses the new
  painting too.
- **Plugins page you can read:** a plain introduction, the list first, real on/off switches that
  say which plugin they changed, and adding a plugin from a link folded away at the bottom with
  what such a plugin can and cannot do. Four switches that changed nothing are gone (Custom CSS,
  Font Picker, Link Preview, Code Highlight) and the rest have plain names.
- **Spoilers for everyone:** `||text||` is hidden until clicked for every reader. It used to be
  a plugin, so only readers who had switched it on got it.
- **Plainer wording across the app,** and several lines that were not true are fixed: a DM opened
  from a one-time link is not encrypted until the lock is on, a recovery code restores keys but
  does not sign you in, uploads have a size limit, and the dead man's switch now says what it
  deletes. Notifications no longer shows server setup instructions to everyone.
- **ohiyo.gg comes alive:** the birds now flap their wings and fly in two flocks, near and far.
  Butterflies and drifting seeds move over the meadow, a rabbit peeks over the hill now and
  then, a shooting star crosses the night sky, sun rays turn slowly behind the sunrise, and
  Kikka breathes on her hill. Scenes hold still while they are off screen, and everything stops
  for people who ask for reduced motion.
- **ohiyo.gg scenery:** the landing page now looks like a day in a valley, painted in
  gouache. A dawn valley behind the top of the page, a starry night behind the privacy
  section, a sunrise behind the mission, and Kikka on a hill in the morning at the end. A few
  small things move on top of the paintings (a glow on the sun, mist, birds, twinkling stars,
  fireflies) and stop for people who ask for reduced motion. Hard outlines and block shadows
  are replaced by soft shapes and soft shadows.
- **ohiyo.gg redesign:** a new landing page in plain language, built from real app
  screenshots and the Kikka mark. It explains how Ohiyo works in three steps, shows what the
  lock does with a small demo, and states the mission. Fonts are self-hosted, so the site
  now loads nothing from other websites. The privacy, terms, threat model and status pages
  share the new look.
- **ohiyo.gg claims brought up to date:** the page no longer advertises Instant Servers (off
  on the hosted service) or the desktop downloads (the released builds still point at the
  old server), and it says plainly that channels in a space are not end-to-end encrypted.
  The privacy and terms pages name the current server address.
- **Dream mode glow:** the whole room now takes the video's colours (a wider, much more
  saturated blur, with a lighter dimmer over the page), and the video no longer ends in a
  rectangle: the glow fades in over its edges, so the picture dissolves into a blur of itself.
  The fade is a little narrower at the top and bottom so the player's title and controls stay
  readable. The middle of the video is never touched.
- **Dream mode is desktop only:** the button no longer appears on phones or touch-first
  tablets (including a phone held sideways), or in a window narrower than 701px. If a
  desktop window is shrunk to that size while Dream is on, Dream turns off and stays off
  when the window grows again. Cinema is unchanged.
- **Default avatar:** a member who has not set a profile picture now shows the Ohiyo logo
  instead of their first initial, in chat, the member lists, profile cards, calls and settings.
  Group chats keep their letter. The two sidebar circles that painted no background (so the
  letter was dark on dark) now draw their gradient.
- **Home rail:** use the Ohiyo logo in place of its initials and remove the lightning
  shortcut. Instant Servers remains available from the command palette (Ctrl/⌘K).
- **The hosted backend moved from Fly.io to Railway and started with an empty
  database.** Existing hosted accounts, messages and files were not carried over, and
  the web app drops a stored `ohiyo.fly.dev` home and asks you to sign in again. The
  desktop app connects to the new server: release builds now take the server address from
  `client/.env.production` instead of a repository secret that still named the old one.
  Instant Servers are unavailable on the hosted service until they are rebuilt for
  another provider. The hosted web app is served from a container (`client/Dockerfile`)
  on Railway as well, and `scripts/deploy-web.sh` deploys it.
- Group encryption is now labelled **Experimental** in the app, with a note that it can
  miss messages sent while a member was offline.
- Deleting a message now also deletes its attachments when nothing else refers to them.
- Message history pages no longer skip or repeat messages created in the same second.
- The gateway now answers heartbeats, so an idle connection is no longer treated as
  dead and reconnected every 40 seconds.
- A call is no longer dropped when another of your devices disconnects.
- A member with Manage Roles now creates roles just below their own highest role, so
  they can manage what they create.
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
- **No more missed messages after a reconnect.** When a phone wakes, Wi-Fi changes or the
  server restarts, the open chat now catches up on what was sent, edited or deleted while
  you were away. A connection that falls too far behind starts over instead of silently
  losing events.
- **A deleted account leaves everyone's screen at once.** Its messages disappear live, and
  1:1 chats with it show "Deleted account" with no message box.
- **A space you join shows up on your other devices** without a reload.
- **Missing data no longer looks like loss.** If your spaces or chats can't be fully read
  when you connect, the app reconnects instead of showing them empty.
- **Two things at once no longer give a server error:** opening the same DM twice (you get
  one DM), signing up with the same name twice (the second is told it's taken), quick
  reaction taps, two people sending each other friend requests (they become friends), and
  adding someone to a group twice (they're added once).
- **Changing your password with two tabs open** keeps the other tab signed in after a
  reload.
- **A signed-out device keeps checking** when the server can't be reached, instead of
  getting stuck.
- **Linked devices says when its list didn't load,** with Try again, instead of showing no
  devices. Each Remove button names its device.
- **A light custom theme gets readable warning colours.**
- **Sending a file that's no longer stored** is refused with "A file in this message is no
  longer stored. Attach it again." instead of sending the message without it.
- **Rows with reactions, and links with no preview,** no longer overlap the next message or
  leave a gap.
- **A new device's first key upload no longer fails sometimes.** It could arrive while
  the same device was signing in to the live connection, and the server answered with an
  error instead of waiting a moment. Opening a private DM link, and the dead-man's switch
  deleting messages, had the same problem and are fixed the same way.
- **Warning notes show in a warning colour.** The note asking you to back up again (for an
  older recovery backup) and a sleeping or waking Instant Server asked for a warning colour
  no theme defined, so they showed as plain text. Every theme has one now, readable on its
  own backgrounds; custom themes can set it in the theme editor.
- **A device whose session ended now goes to sign-in.** When every session was ended from
  another device (or by a password change), the others sat on "Reconnecting you now…"
  forever. They now notice, go to the sign-in screen, and say why.
- **Restoring your keys on a new device no longer leaves a dead device behind.** A restore
  makes the new device take over the backed-up device. Before, the new device's own
  sign-in stayed listed on your account with keys nothing could use. People kept sending
  it a copy of every encrypted message that no one could read, and it counted toward your
  10-device limit. It is now removed during the restore, or at your next sign-in if that
  fails.
- **Encrypted chats keep working after a restore.** If you sent an encrypted message from
  the new device before restoring, the people you sent it to could not read anything you
  sent after the restore, on the devices that got that message. The restore now replaces
  the new device's own encryption state instead of mixing it with the backup's.
- **Restored disappearing messages now disappear on time.** Restoring a recovery backup made
  before backups became keys-only also restores the readable copies of old encrypted
  messages it held. Those copies were stored where the expiry cleanup never looked, so a
  disappearing message among them that you never opened stayed on the device after its
  time ran out. The cleanup now finds them when you sign in: copies already past their
  time are deleted, and the rest disappear on schedule. Expired copies also no longer wait
  for you to open an encrypted chat before they are cleaned up.
- **Locked messages no longer overlap.** On a new device, a message it can't decrypt yet
  shows a card that explains why, with an "Open recovery" button. The chat list made room
  for one line of text, so the next message covered the card and its button. The list now
  makes room for the whole card, on phones too.
- **Your own encrypted messages stay readable.** Right after you sent a message in an
  encrypted chat, it could turn into "This message needs keys this device doesn't have" on
  your own screen until you reloaded. The message was never lost and the other person could
  always read it; your copy now stays readable too.
- **Desktop: no more frozen white window at launch.** When your computer asks for a password
  before it lets Ohiyo read its saved keys (a Mac does after every update of the unsigned
  beta), the app used to sit frozen behind that prompt with an empty window. It now shows
  "Unlocking your keys" and says what the prompt is for.
- **A calmer first screen.** The owner's launch checklist no longer fills the sidebar: it is
  one "Getting started" row under the channels that opens when you want it. The message box
  has a single "+" with "Upload a file" and "Create a poll" inside. The home switcher and its
  own "+" moved to the bottom of the far-left rail, so the "+" beside your spaces is the only
  one in reach. People who run a space are no longer offered a button to report it.
- **The app on phones:** message text no longer runs underneath each message's ⋯ button,
  and touching a message no longer pops the desktop toolbar over its neighbours. The ⋯ menu
  can add a reaction. The app is sized to the part of the screen the browser leaves
  visible, so the message box is not hidden behind the browser's bar. The channel drawer is
  wider, lists the channels before the launch checklist, and its small buttons are big
  enough to hit. Dialogs and the call screen fit the screen, the sign-in and first-space
  screens scroll on small phones instead of cutting their tops off, notices appear at the
  top instead of over the newest messages, and fields no longer make an iPhone zoom in.
- **Settings said no notification ever shows message text.** That is true of push
  notifications only. Notifications while Ohiyo is running show who wrote and the start
  of the message, except in encrypted chats. The page now says so.
- **"Invite someone" gives a real invite:** the step in the first-run checklist copied a note
  about Ohiyo with a link to the project, so a friend who followed it did not land in your
  space. It now opens the space's own invite link, the same one the sidebar's Invite button
  makes.
- **ohiyo.gg could be drawn with last release's styles:** browsers keep the stylesheet for ten
  minutes, and pages linked it by a fixed name. Right after a release, a returning visitor
  could get the new page with the old stylesheet: the phone screenshot broke out of its frame,
  the headline ran across the sculpture and the menu sat on the stone. Pages now link the
  stylesheet and script by a hash of their contents, so a new page always loads the new files.
- **The menu and headline on ohiyo.gg stand out more:** a veil of light sits behind the menu
  and a soft haze behind the words, and the menu's letters are heavier. On very wide screens
  the first screen now follows the painting's full height, so the sculpture's top is not cut
  off and the menu never lands on it.
- **Settings on a phone:** under 560px wide the settings tabs shrank to eight identical dots
  with no names, and the only "Back to Ohiyo" button was hidden with them, so there was no
  way to tell the tabs apart or to leave Settings. The tabs are now a row of named pills that
  scrolls sideways, with "Back to Ohiyo" always at the top.
- **Videos in chat no longer start over:** every row of the chat was thrown away and rebuilt
  whenever the chat re-rendered, which happens on each letter you type and each new message.
  Anything living in a row was reset: a playing video restarted, a revealed spoiler hid again.
  Rows now keep their identity (and keep it when older history loads in above them).
- **Link cards no longer run into the next message:** the space kept for a YouTube card was
  too small at full width, and a link written twice got two cards with room for one. Cards
  now have fixed sizes that the list knows, each link gets one card (none for a link inside
  code or a spoiler), and long links are counted the way a browser wraps them.
- **Punctuation after a link is no longer swallowed:** "(https://example.com)." lost its
  closing bracket and full stop.
- **The chat follows the window:** narrowing a desktop window no longer leaves the chat wide and
  the message box off screen, and on a phone a message that wraps onto a second line no longer
  runs into the one below it. Rows are now sized for the real width of the chat, for the phone
  font size, and for wide characters such as emoji and CJK.
- **`/me` sends italics:** it sent `_underscores_`, which the chat does not render.
- **Focus mode on a phone:** it hid the drawer, which is the only way to another chat or back to
  Settings. It now only hides the sidebars on wide windows.
- **Dream mode's glow and the blur behind dialogs were missing in the production app:** the
  production build kept only `-webkit-backdrop-filter` for two rules, which Chrome, Edge and
  Firefox ignore, so the blur never applied there (it looked fine in development, which does
  not minify CSS). Both rules now keep the standard property, and a test runs the real
  production build to catch this.
- **Profile editor:** Grouped, responsive fields with visible focus and character counts; fixed the avatar being hidden behind the banner.
- **Top songs:** Compact add/edit/remove favorites, optional listening links with validation, and a simpler public music list. Drafts remain local until Save profile.
- **Watch parties work on the web app.** A YouTube party showed an empty box, because
  the site's security policy blocks YouTube's player script; the player is now an embed
  driven by messages, so nothing from YouTube runs inside the app. Guests are kept in
  step when they pause or scrub (only the host controls playback) and no longer get an
  End button that did nothing. Sync no longer depends on each device's clock being
  right, and a browser that blocks autoplay shows a "Click to join the party" button.
- The server image builds again: the Discord import tool it bundles is pinned to a
  release instead of cloning its latest commit, which had started to need a newer Go.
- Turning on encryption in a DM right after a reload no longer fails with "your friend
  needs to open Ohiyo".
- One undecryptable message no longer makes a group chat load empty.
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

[Unreleased]: https://github.com/New1Direction/ohiyo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/New1Direction/ohiyo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/New1Direction/ohiyo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/New1Direction/ohiyo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/New1Direction/ohiyo/releases/tag/v0.1.0
