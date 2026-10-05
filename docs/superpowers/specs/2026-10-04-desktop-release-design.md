# Ohiyo Desktop 0.3.0 — Design Spec

**Date:** 2026-10-04
**Status:** Design approved in conversation; this file awaits review before planning
**Author:** Brainstormed with ares

---

## 1. What this is

A desktop release people can live in: it stays running in the tray, notifications keep
arriving, voice works, and it updates itself. The Tauri app exists already; this release
finishes it and publishes it.

Success: someone downloads Ohiyo for Mac or Linux from ohiyo.gg, signs in to the live
server, closes the window, still gets told when a friend writes, joins a voice room on Mac,
and is offered the next version without visiting the site again.

## 2. Where it stands today

| | Today |
|---|---|
| Builds | Mac (Apple Silicon, Intel) and Linux, from `.github/workflows/release.yml` on a version tag |
| Last release | v0.2.0 (June). It has `https://ohiyo.fly.dev` built in, the old server |
| Mac signing | None. The repo's only secret is `VITE_SERVER_URL`; builds are ad-hoc signed |
| Voice on Mac | No microphone or camera usage text and no entitlements file, which macOS requires |
| Tray, unread badge, open at login | None |
| Closing the window | Quits the app, so notifications stop |
| Updates | None. Installed copies cannot be fixed |
| Windows | Disabled: the key vault (`crates/goodnight`) uses POSIX-only memory calls |

## 3. Decisions

| Question | Decision |
|---|---|
| Platforms | Mac and Linux now. Windows is its own release, after the vault is ported. |
| Mac signing | Unsigned (ad-hoc) for now, published as a beta with the steps to open it. |
| Updates | The app updates itself, and asks first. |
| Publishing | Nothing is public until the owner says publish. |

Choices made while writing this, not yet discussed. Change any of them:

- **Keep running on close** defaults to on for Mac and off for Linux. Many Linux desktops
  show no tray, and a hidden window with no tray icon looks like a crashed app.
- **Which messages notify** is unchanged: every message from someone else in a chat you
  are not looking at. With the app always running that may be a lot; limiting background
  notifications to DMs and mentions would be a separate change.
- The version is **0.3.0** for the client and the desktop crate. The server keeps its own.

## 4. Tray and window

- **Tray icon** with a menu: Open Ohiyo · Leave call (only while in one) · Check for
  updates · Open at login (a tick) · Quit Ohiyo.
- **Closing the window** hides it when "Keep running" is on; the app and its connection
  stay up. The first time, one notification says "Ohiyo is still running in the menu bar"
  (Linux: "in the tray"). Cmd+Q and the tray's Quit really quit.
- **Coming back:** a click on the tray icon, on the Mac dock icon, on a notification, or a
  second launch shows and focuses the window.
- **Unread:** the total unread count is the number on the Mac dock icon and is in the tray
  tooltip ("Ohiyo, 3 unread"). Zero clears it.
- **A hidden window is never "looking at" a chat,** so messages in the open channel notify
  and count as unread while the window is hidden.
- **Settings → Notifications** gains a "Desktop app" card, shown only in the desktop app,
  with two switches: "Keep running when I close the window" and "Open Ohiyo when I log in".

Where the state lives: "Keep running" is a small JSON file in the app's config folder,
read by the Rust side when the window is asked to close. "Open at login" is owned by the
operating system through `tauri-plugin-autostart`.

## 5. Voice

- **Mac:** add `Info.plist` with the microphone and camera usage text, and an entitlements
  file granting audio input and camera, referenced from `tauri.conf.json`. Without them
  macOS refuses the microphone.
- **Any shell that cannot call** (the Linux app's web engine is the likely case): the app
  checks for `getUserMedia` and `RTCPeerConnection`. If either is missing, voice rooms say
  "Voice isn't available in this app yet. Open Ohiyo in your browser to join." instead of
  failing after the click.
- **Not changed:** the hosted server has no relay (TURN), so calls can fail on strict
  networks, in the browser as well. That is separate work.

## 6. Notifications

- Native notifications already fire while the app runs. With the tray they continue after
  the window is closed.
- Encrypted messages keep showing "Sent an encrypted message", never their text.
- Not possible in this release: notifications after the app is fully quit. On Mac that needs
  Apple push certificates, which need the paid developer account.
- **A sentence to correct.** Settings currently says "A notification never includes message
  text". That is true of push notifications only. A notification shown while Ohiyo is running
  carries the sender's name and the start of the message (encrypted chats excepted). The
  sentence was introduced in the wording pass of PR #87 and is fixed here.

## 7. Updates

- `tauri-plugin-updater`, reading `latest.json` from the newest published GitHub release.
  Draft releases are invisible to it, so testing a draft never updates anyone.
- The app checks after sign-in and every six hours. A newer version shows a bar: "Ohiyo
  0.3.1 is ready" with **Update now** and **Later**. Update now downloads, installs and
  restarts. Later hides the bar until the next start. The tray's "Check for updates" does
  the same check on demand and says so when there is nothing new.
- **Signing.** Updates are signed with a key made for this purpose. The public half is in
  `tauri.conf.json`; the private half and its password are GitHub secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). A copy is saved to a
  file on the owner's Desktop to move into a password manager. Without the key, installed
  copies can no longer be updated.
- Linux: only the AppImage updates itself. The deb and rpm are updated by downloading again.
- v0.2.0 has no updater. Its users download once more.

## 8. Code layout

```
client/src-tauri/
  Info.plist                 microphone and camera usage text         (new)
  Entitlements.plist         audio input, camera                      (new)
  Cargo.toml                 tauri "tray-icon"; autostart and updater plugins
  tauri.conf.json            version, entitlements, updater key + endpoint, updater artifacts
  capabilities/default.json  window show/hide/focus/badge, autostart, updater
  src/lib.rs                 registers plugins, tray and window lifecycle
  src/tray.rs                tray icon, menu, events                  (new)
  src/prefs.rs               "keep running" file, read and written    (new)
client/src/
  lib/desktopShell.ts        calls into the shell; no-ops in a browser (new)
  lib/unreadTotal.ts         pure: total and label from the unread map (new)
  lib/voiceSupport.ts        pure: can this shell make a call          (new)
  hooks/useDesktopShell.ts   keeps badge, tray and call state in step  (new)
  components/UpdateBar.tsx   "Ohiyo x is ready"                        (new)
  components/settings/DesktopAppCard.tsx  the two switches           (new)
.github/workflows/release.yml  updater signing, updater artifacts
```

Everything desktop-only sits behind `isDesktop()`, so the web app is unchanged.

## 9. Release

1. Set the `VITE_SERVER_URL` secret to `https://ohiyo-server-production.up.railway.app`,
   the address the web app uses. It is a public address.
2. Make the update key; store the secrets; save the owner's copy.
3. Bump to 0.3.0, merge, push tag `v0.3.0`. The workflow builds a **draft** release: two
   Mac DMGs, AppImage, deb, rpm, the updater bundles and `latest.json`. A draft is not
   visible to the public and the updater ignores it.
4. Test the draft's Mac build (section 10).
5. The owner says publish. The release is published.
6. Then, in its own change: ohiyo.gg gets a Download section. Mac is labelled a beta that
   Apple has not verified, with the steps to open it (System Settings → Privacy & Security
   → Open Anyway). The site test that forbids download links is replaced by one that checks
   they point at the published version. LAUNCH-STATUS.md, GO-LIVE.md and the README follow.

## 10. Testing

- **Rust unit tests:** the "keep running" file (missing, corrupt, round trip, per-platform
  default); what a close request does for each setting; the tray tooltip text.
- **Client unit tests:** unread total and label; the voice-support check; the update bar and
  the settings card render in the desktop app and not in a browser.
- **CI:** the Desktop job compiles and tests the crate on Linux, as today. The release
  workflow is run by hand once before tagging to prove it still produces a draft.
- **By hand on the built Mac app,** as far as one machine allows: it starts and signs in to
  the live server; closing hides it and the tray brings it back; a message from a browser
  account produces a notification and a dock badge while the window is hidden; open at login
  registers and unregisters; the update bar appears for a higher test version and installs.
- **Needs a person:** allowing the microphone, and one real call between the Mac app and a
  browser.
- **Not tested:** the Linux app's window, tray and voice (no Linux desktop here). It is
  built by CI and published as untested.

## 11. The gate before publishing

Unsigned Mac builds have no stable identity. After an update, macOS may ask for the
microphone again, and may ask for the keychain password before the key vault opens.

Before the release is published, build A is installed, used to create encryption keys,
then updated to build B through the updater. If the vault does not open afterwards, the
updater is switched off for Mac in this release (Mac users update by downloading) and the
owner is told. Losing someone's keys is not an acceptable price for self-updating.

## 12. Not in this release

Windows; Apple signing and notarization; notifications after quit; a call relay (TURN);
changing which messages notify; mobile apps.
