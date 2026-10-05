# Ohiyo Desktop 0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a desktop app for Mac and Linux that stays in the tray, keeps notifying, makes voice calls on Mac, and updates itself.

**Architecture:** The Tauri shell (Rust, `client/src-tauri`) gains a tray, a close-to-tray rule read from a small prefs file, open-at-login and the updater plugin. The React app talks to the shell through one module (`lib/desktopShell.ts`) that does nothing in a browser, so the web app is unchanged. Everything the shell does for the app goes through our own Rust commands, so the webview gets one new permission only (`updater:default`). Release is the existing tag-triggered workflow, with update signing added.

**Tech Stack:** Tauri 2.11 (`tray-icon`, `image-png`), `tauri-plugin-autostart` 2.7, `tauri-plugin-updater` 2.13, React 19 + TypeScript, `node --test`, `cargo test`, GitHub Actions (`tauri-action`).

**Spec:** `docs/superpowers/specs/2026-10-04-desktop-release-design.md`

## Global Constraints

- Platforms: Mac (Apple Silicon, Intel) and Linux. No Windows work.
- Mac builds stay ad-hoc signed (`"signingIdentity": "-"`). Never describe them as Apple verified.
- Version is `0.3.0` in `client/package.json`, `client/src-tauri/Cargo.toml`, `client/src-tauri/tauri.conf.json`. The server's version does not change.
- Everything desktop-only is behind `isDesktop()` (`client/src/lib/desktop.ts`). The web app must behave exactly as before.
- "Keep running when I close the window" defaults to on for Mac and off for Linux.
- Which messages notify does not change.
- Nothing is published without the owner saying so. A draft release is not public.
- No accounts are created on the production server. Hands-on checks use a local throwaway server.
- **This Mac has Ohiyo 0.2.0 installed** (`/Applications/Ohiyo.app`, data in `~/Library/Application Support/app.ohiyo.desktop`, a keychain entry `kikkacord` / `vault-master`). No build made while working on this plan may be launched with the real identifier or the real keychain entry. Test builds are isolated (Task 7, Task 9).
- The update key is never printed, never committed, and never pasted into a chat.
- Commits: conventional format, author `ares`, no attribution lines, no "Generated with" footer.
- `SCRATCH=/private/tmp/claude-501/-Users-clubpenguin/52051fd6-aaf0-40fd-bdbc-183d3a6daaed/scratchpad`
- Low disk (about 6.5 GB free). Every cargo command uses
  `export CARGO_TARGET_DIR="$SCRATCH/desktop-target" CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`.
  Before any release build: `rm -rf "$CARGO_TARGET_DIR/debug"` and check `df -h /` shows at least 4 GB free.
- The desktop crate embeds `client/dist` at compile time. Before any cargo command:
  `mkdir -p client/dist && [ -f client/dist/index.html ] || printf '<!doctype html><title>dev</title>\n' > client/dist/index.html`
- Local stack (for e2e and hands-on checks; start the server from `$SCRATCH/stack`, never from the repo, because it writes `uploads/` where it starts):
  - server: `mkdir -p "$SCRATCH/stack" && cd "$SCRATCH/stack" && JWT_SECRET=$(openssl rand -base64 48) DATABASE_URL="sqlite:$SCRATCH/stack/test.db?mode=rwc" BIND_ADDR=127.0.0.1:3000 OHIYO_REGISTER_LIMIT_PER_HOUR=0 PUBLIC_BASE_URL=http://localhost:3000 CORS_ALLOWED_ORIGINS=http://localhost:1420,tauri://localhost "$SCRATCH/probe/server/target/debug/server"`
  - web client: `cd client && VITE_SERVER_URL=http://localhost:3000 npx vite --port 1420 --strictPort`
  - e2e: `KIKKA_ORIGIN=http://localhost:1420 node e2e/run.mjs <filter>`

## Rulings made while planning

Places where the plan departs from the spec's wording, or settles something the spec left open. Task 8 updates the spec text to match.

1. **A click on the tray icon opens its menu.** The spec said a click shows the window. On a Mac a menu bar icon opens a menu, and Linux trays offer nothing but a menu. "Open Ohiyo" is the first item. The Dock icon, a second launch and a notification bring the window back directly. Cost if wrong: one line to change (`show_menu_on_left_click(false)` plus a click handler).
2. **On a Mac, closing hides the app the way Cmd+H does,** not only the window. Then anything that activates Ohiyo (Dock, Cmd+Tab, a notification) brings the window back without extra code. Cost if wrong: swap `app.hide()` for `window.hide()`.
3. **"Can this shell call" checks `RTCPeerConnection` only.** The spec also named `getUserMedia`, but Ohiyo already joins listen-only without a microphone (`useWebRTC.ts:362`, e2e `25-listen-only-call`).
4. **Update bundles are switched on by the release workflow, not in `tauri.conf.json`.** With it in the config, a plain `npm run tauri build` (README, DEPLOY.md) would fail for anyone without our private key.
5. **The update gate runs before the tag is pushed,** on isolated local builds of the merged code. A failure then costs a pull request, not a deleted tag and draft.
6. **Download links name the published version** (`releases/download/v0.3.0/…`), not `releases/latest/download/…`. File names contain the version, so a "latest" link breaks the moment the next version is published. An older installer updates itself on first run.
7. **LAUNCH-STATUS.md, GO-LIVE.md and the README status line change when the release is published** (Task 11), not when the code merges, so they never describe a release that is not public.

## Review Focus

1. **Linux desktop with no tray.** Closing must quit there by default; and with no tray at all, closing must quit whatever the setting. (Task 2 tests the default; Task 3 tests the close rule.)
2. **A damaged prefs file.** The app must start with defaults, not crash or stay hidden. (Task 2.)
3. **Unread counts that are not clean numbers** (missing, negative, fractional, `NaN`). The badge must be a whole number or absent. (Task 4.)
4. **Update check with no network.** Checks the app starts by itself stay silent; only a check the person asked for reports failure. (Task 6.)
5. **A message arriving in the open chat while the window is hidden.** It must notify, count as unread, and be marked read when the window comes back. (Task 4.)

---

### Task 1: Voice — Mac permissions, and a plain message where calls cannot work

**Files:**
- Create: `client/src-tauri/Info.plist`
- Create: `client/src-tauri/Entitlements.plist`
- Modify: `client/src-tauri/tauri.conf.json` (`bundle.macOS`)
- Create: `client/src/lib/voiceSupport.ts`
- Modify: `client/src/App.tsx` (`handleJoinVoice`, imports)
- Test: `client/test/voiceSupport.test.ts`, `client/test/desktopBundle.test.ts`

**Interfaces:**
- Produces: `canCall(env: CallEnvironment): boolean`, `callEnvironment(): CallEnvironment`, `VOICE_UNAVAILABLE: string` from `client/src/lib/voiceSupport.ts`.

- [ ] **Step 1: Write the failing tests**

`client/test/voiceSupport.test.ts`:

```ts
// Some desktop shells cannot make calls at all (the Linux app's web engine is the likely
// one). The app says so before trying, instead of failing after the click.
//   node --experimental-strip-types --test test/voiceSupport.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { VOICE_UNAVAILABLE, canCall } from "../src/lib/voiceSupport.ts";

class FakePeerConnection {}

test("a shell with peer connections can call", () => {
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: { getUserMedia() {} } }), true);
});

test("no microphone access is still a call: Ohiyo joins listen-only", () => {
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: undefined }), true);
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: null }), true);
});

test("a shell without peer connections cannot call", () => {
  assert.equal(canCall({ RTCPeerConnection: undefined, mediaDevices: { getUserMedia() {} } }), false);
  assert.equal(canCall({}), false);
});

test("the message tells the person where a call does work", () => {
  assert.equal(VOICE_UNAVAILABLE, "Voice isn't available in this app yet. Open Ohiyo in your browser to join.");
});
```

`client/test/desktopBundle.test.ts`:

```ts
// What the packaged desktop app is built from: the files and settings macOS and the
// updater need. A missing one only shows up on a user's machine, so they are pinned here.
//   node --experimental-strip-types --test test/desktopBundle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tauri = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const read = (name: string) => readFileSync(join(tauri, name), "utf8");
const conf = JSON.parse(read("tauri.conf.json"));

// The <string> or <true/> that follows a <key> in a plist.
function plistValue(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*(<string>([^<]*)</string>|<true/>)`).exec(plist);
  return match ? (match[2] ?? "true") : null;
}

test("macOS is told why Ohiyo wants the microphone and the camera", () => {
  const plist = read("Info.plist");
  for (const key of ["NSMicrophoneUsageDescription", "NSCameraUsageDescription"]) {
    const text = plistValue(plist, key);
    assert.ok(text && text.length > 20, `${key} has a real sentence`);
  }
});

test("the app is entitled to audio input and the camera, and the build uses that file", () => {
  const entitlements = read("Entitlements.plist");
  assert.equal(plistValue(entitlements, "com.apple.security.device.audio-input"), "true");
  assert.equal(plistValue(entitlements, "com.apple.security.device.camera"), "true");
  assert.equal(conf.bundle.macOS.entitlements, "./Entitlements.plist");
});

test("Mac builds stay ad-hoc signed until there is an Apple account", () => {
  assert.equal(conf.bundle.macOS.signingIdentity, "-");
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd client && node --experimental-strip-types --test test/voiceSupport.test.ts test/desktopBundle.test.ts`
Expected: FAIL (`Cannot find module .../voiceSupport.ts`; `ENOENT ... Info.plist`).

- [ ] **Step 3: Implement**

`client/src-tauri/Info.plist` (Tauri merges a file with this name into the app's own):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>Ohiyo uses the microphone so the people in your voice room can hear you.</string>
  <key>NSCameraUsageDescription</key>
  <string>Ohiyo uses the camera when you turn on video in a call.</string>
</dict>
</plist>
```

`client/src-tauri/Entitlements.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
</dict>
</plist>
```

In `client/src-tauri/tauri.conf.json`, replace

```json
    "macOS": {
      "signingIdentity": "-"
    }
```

with

```json
    "macOS": {
      "signingIdentity": "-",
      "entitlements": "./Entitlements.plist"
    }
```

`client/src/lib/voiceSupport.ts`:

```ts
// Can this browser or desktop shell make a call at all? Pure, for unit tests.
// A missing microphone is not a blocker: Ohiyo joins listen-only (see useWebRTC).

export interface CallEnvironment {
  RTCPeerConnection?: unknown;
  mediaDevices?: { getUserMedia?: unknown } | null;
}

export const VOICE_UNAVAILABLE = "Voice isn't available in this app yet. Open Ohiyo in your browser to join.";

/** True when peer connections exist, which is the one thing a call cannot do without. */
export function canCall(env: CallEnvironment): boolean {
  return typeof env.RTCPeerConnection === "function";
}

/** The real environment, read at call time. */
export function callEnvironment(): CallEnvironment {
  return {
    RTCPeerConnection: typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection,
    mediaDevices: typeof navigator === "undefined" ? null : navigator.mediaDevices,
  };
}
```

In `client/src/App.tsx`, add next to the other `./lib/` imports:

```ts
import { VOICE_UNAVAILABLE, callEnvironment, canCall } from "./lib/voiceSupport";
```

and in `handleJoinVoice` (the only caller of `webrtc.joinVoice`), between `setMobileNavOpen(false);` and `if (webrtc.channelId === channel.id) return;`:

```ts
    if (!canCall(callEnvironment())) {
      toast(VOICE_UNAVAILABLE, "error");
      return;
    }
```

- [ ] **Step 4: Run the tests, the type check and lint**

Run: `cd client && node --experimental-strip-types --test test/voiceSupport.test.ts test/desktopBundle.test.ts && npx tsc --noEmit && npx eslint src/App.tsx src/lib/voiceSupport.ts`
Expected: 7 tests pass; no type or lint output.

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/Info.plist client/src-tauri/Entitlements.plist client/src-tauri/tauri.conf.json client/src/lib/voiceSupport.ts client/src/App.tsx client/test/voiceSupport.test.ts client/test/desktopBundle.test.ts
git commit -m "feat(desktop): microphone and camera permissions on Mac, and a plain message where calls cannot work"
```

---

### Task 2: Desktop prefs the native side can read

**Files:**
- Create: `client/src-tauri/src/prefs.rs`
- Modify: `client/src-tauri/src/lib.rs`

**Interfaces:**
- Produces (Rust): `prefs::DesktopPrefs { keep_running: bool, tray_hint_shown: bool }` (`Copy`), `prefs::PrefsState::get(&self) -> DesktopPrefs`, `prefs::PrefsState::update(&self, impl FnOnce(&mut DesktopPrefs)) -> DesktopPrefs`, `prefs::init(&AppHandle)`.
- Produces (commands): `desktop_prefs_get() -> DesktopPrefs`, `desktop_prefs_set(keep_running: bool) -> DesktopPrefs`. On the wire: `{ "keep_running": bool, "tray_hint_shown": bool }`; the argument is `keepRunning`.

- [ ] **Step 1: Write the types and the failing tests**

`client/src-tauri/src/prefs.rs`:

```rust
//! Settings the native side has to read without asking the webview: whether closing the
//! window keeps Ohiyo running in the tray, and whether the one-time "still running" hint
//! has been shown. A small JSON file in the app's config folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const PREFS_FILE: &str = "desktop-prefs.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct DesktopPrefs {
    /// Closing the window hides it and the app stays in the tray.
    #[serde(default = "default_keep_running")]
    pub keep_running: bool,
    /// The "Ohiyo is still running" notification has been shown once.
    #[serde(default)]
    pub tray_hint_shown: bool,
}

/// On where a tray is always there (the Mac menu bar). Off on Linux, where many desktops
/// show no tray and a hidden window would look like a crashed app.
fn default_keep_running() -> bool {
    cfg!(target_os = "macos")
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self { keep_running: default_keep_running(), tray_hint_shown: false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ohiyo-prefs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(PREFS_FILE)
    }

    #[test]
    fn a_missing_file_gives_the_platform_default() {
        let prefs = load(&scratch_file("missing"));
        assert_eq!(prefs, DesktopPrefs::default());
        assert_eq!(prefs.keep_running, cfg!(target_os = "macos"));
        assert!(!prefs.tray_hint_shown);
    }

    #[test]
    fn a_damaged_file_gives_the_default_instead_of_failing() {
        let path = scratch_file("damaged");
        for junk in ["", "{", "not json", "[1,2,3]", "{\"keep_running\": \"yes\"}"] {
            std::fs::write(&path, junk).unwrap();
            assert_eq!(load(&path), DesktopPrefs::default(), "{junk:?}");
        }
    }

    #[test]
    fn what_is_saved_is_what_loads() {
        let path = scratch_file("round-trip");
        for keep_running in [true, false] {
            let prefs = DesktopPrefs { keep_running, tray_hint_shown: true };
            save(&path, prefs).unwrap();
            assert_eq!(load(&path), prefs);
        }
    }

    #[test]
    fn a_file_from_an_older_or_newer_version_still_loads() {
        let path = scratch_file("versions");
        // Older: no hint field yet. Newer: a field this version does not know.
        std::fs::write(&path, "{\"keep_running\": false}").unwrap();
        assert_eq!(load(&path), DesktopPrefs { keep_running: false, tray_hint_shown: false });
        std::fs::write(&path, "{\"keep_running\": true, \"tray_hint_shown\": true, \"later\": 3}").unwrap();
        assert_eq!(load(&path), DesktopPrefs { keep_running: true, tray_hint_shown: true });
    }

    #[test]
    fn an_update_is_saved_and_returned() {
        let path = scratch_file("update");
        let state = PrefsState { path: path.clone(), current: Mutex::new(DesktopPrefs::default()) };
        let after = state.update(|prefs| prefs.keep_running = !prefs.keep_running);
        assert_eq!(after.keep_running, !DesktopPrefs::default().keep_running);
        assert_eq!(load(&path), after);
        assert_eq!(state.get(), after);
    }
}
```

In `client/src-tauri/src/lib.rs`, add `mod prefs;` on the line above `mod vault;`.

- [ ] **Step 2: Run the tests and see them fail**

Run (Global Constraints exports and the `client/dist` stand-in in place): `cd client/src-tauri && cargo test --locked prefs`
Expected: does not compile (`cannot find function load`, `save`, `PrefsState`).

- [ ] **Step 3: Implement**

In `prefs.rs`, between `impl Default for DesktopPrefs { … }` and the tests module, add:

```rust
/// The saved prefs, or the defaults when the file is missing or cannot be read as prefs.
pub fn load(path: &Path) -> DesktopPrefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write through a temp file so a crash mid-write never leaves half a file.
pub fn save(path: &Path, prefs: DesktopPrefs) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(&prefs).map_err(std::io::Error::other)?)?;
    std::fs::rename(&temp, path)
}

pub struct PrefsState {
    path: PathBuf,
    current: Mutex<DesktopPrefs>,
}

impl PrefsState {
    pub fn get(&self) -> DesktopPrefs {
        *self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Change the prefs and save them. A failed save keeps the change for this run.
    pub fn update(&self, change: impl FnOnce(&mut DesktopPrefs)) -> DesktopPrefs {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut current);
        if let Err(e) = save(&self.path, *current) {
            eprintln!("[ohiyo] couldn't save desktop prefs: {e}");
        }
        *current
    }
}

pub fn init(app: &AppHandle) {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(PREFS_FILE);
    let current = Mutex::new(load(&path));
    app.manage(PrefsState { path, current });
}

#[tauri::command]
pub fn desktop_prefs_get(state: State<PrefsState>) -> DesktopPrefs {
    state.get()
}

#[tauri::command]
pub fn desktop_prefs_set(state: State<PrefsState>, keep_running: bool) -> DesktopPrefs {
    state.update(|prefs| prefs.keep_running = keep_running)
}
```

In `lib.rs`: inside `.setup(|app| { … })` add `prefs::init(app.handle());` on the line above `vault::init(app.handle());`, and add `prefs::desktop_prefs_get,` and `prefs::desktop_prefs_set,` to `generate_handler!` after `vault::vault_burn,`.

- [ ] **Step 4: Run the tests and the crate check**

Run: `cargo test --locked prefs && cargo check --locked --all-targets`
Expected: 5 tests pass; the check ends with no errors. (No new crates, so `--locked` holds.)

- [ ] **Step 5: Commit**

```bash
git add client/src-tauri/src/prefs.rs client/src-tauri/src/lib.rs
git commit -m "feat(desktop): prefs file for the close-to-tray setting"
```

---

### Task 3: Tray, close-to-tray, open at login

**Files:**
- Create: `client/src-tauri/icons/tray.png` (rendered from `brand/kikka-chinchilla-mono.svg`)
- Create: `client/src-tauri/src/tray.rs`
- Modify: `client/src-tauri/Cargo.toml`, `client/src-tauri/Cargo.lock`, `client/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `prefs::PrefsState`, `prefs::DesktopPrefs` (Task 2).
- Produces (commands): `desktop_set_unread(count: u32)`, `desktop_set_in_call(in_call: bool)` (argument `inCall`), `desktop_autostart_get() -> bool`, `desktop_autostart_set(enabled: bool) -> bool`.
- Produces (events to the webview): `desktop://leave-call`, `desktop://check-updates` (no payload), `desktop://window-hidden` (payload `bool`).
- Produces (Rust): `tray::init(&AppHandle)`, `tray::show_main(&AppHandle)`, `tray::hide_main(&AppHandle)`, `tray::mark_visible(&AppHandle)`, `tray::close_action(&AppHandle) -> CloseAction`, `tray::MAIN_WINDOW`.

- [ ] **Step 1: Make the menu bar icon and add the dependencies**

```bash
cd ~/Documents/Projects/oHiYo
rsvg-convert -w 44 -h 44 --keep-aspect-ratio brand/kikka-chinchilla-mono.svg -o client/src-tauri/icons/tray.png
sips -g pixelWidth -g pixelHeight client/src-tauri/icons/tray.png | tail -2   # 44 wide, 41 high
```

In `client/src-tauri/Cargo.toml` change the `tauri` line to

```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
```

and under `[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]`, after the single-instance line, add

```toml
# "Open Ohiyo when I log in". Desktop only.
tauri-plugin-autostart = "2"
```

- [ ] **Step 2: Write the pure rules' failing tests**

`client/src-tauri/src/tray.rs`:

```rust
//! The tray icon, and what closing the window does. With "keep running" on, closing hides
//! Ohiyo and it stays in the tray, so notifications keep arriving.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::prefs::{DesktopPrefs, PrefsState};

pub const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";

const EVENT_LEAVE_CALL: &str = "desktop://leave-call";
const EVENT_CHECK_UPDATES: &str = "desktop://check-updates";
const EVENT_WINDOW_HIDDEN: &str = "desktop://window-hidden";

#[derive(Debug, PartialEq)]
pub enum CloseAction {
    /// Hide; the app keeps running in the tray.
    Hide,
    /// Let the window close, which ends the app.
    Quit,
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEEP: DesktopPrefs = DesktopPrefs { keep_running: true, tray_hint_shown: false };
    const QUIT: DesktopPrefs = DesktopPrefs { keep_running: false, tray_hint_shown: false };

    #[test]
    fn the_tooltip_counts_unread_and_is_plain_when_there_are_none() {
        assert_eq!(tooltip(0), "Ohiyo");
        assert_eq!(tooltip(1), "Ohiyo, 1 unread");
        assert_eq!(tooltip(128), "Ohiyo, 128 unread");
    }

    #[test]
    fn the_dock_badge_is_absent_at_zero() {
        assert_eq!(badge(0), None);
        assert_eq!(badge(3), Some(3));
        assert_eq!(badge(u32::MAX), Some(i64::from(u32::MAX)));
    }

    #[test]
    fn closing_hides_only_when_keep_running_is_on() {
        assert_eq!(on_close(KEEP, true), CloseAction::Hide);
        assert_eq!(on_close(QUIT, true), CloseAction::Quit);
    }

    #[test]
    fn without_a_tray_closing_always_quits() {
        // Nothing to click to get the window back: hiding would look like a crash.
        assert_eq!(on_close(KEEP, false), CloseAction::Quit);
        assert_eq!(on_close(QUIT, false), CloseAction::Quit);
    }

    #[test]
    fn linux_quits_on_close_unless_the_person_chose_otherwise() {
        let expected = if cfg!(target_os = "macos") { CloseAction::Hide } else { CloseAction::Quit };
        assert_eq!(on_close(DesktopPrefs::default(), true), expected);
    }
}
```

In `lib.rs` add `mod tray;` between `mod prefs;` and `mod vault;`.

- [ ] **Step 3: Run the tests and see them fail**

Run: `cd client/src-tauri && cargo test tray` (no `--locked`: this run adds `tauri-plugin-autostart` to `Cargo.lock`)
Expected: does not compile (`cannot find function tooltip`, `badge`, `on_close`).

- [ ] **Step 4: Implement the tray**

In `tray.rs`, between the `CloseAction` enum and the tests module, add:

```rust
/// What the tray says when the pointer rests on it.
pub fn tooltip(unread: u32) -> String {
    if unread == 0 {
        "Ohiyo".to_string()
    } else {
        format!("Ohiyo, {unread} unread")
    }
}

/// The number on the dock icon; none when everything is read.
pub fn badge(unread: u32) -> Option<i64> {
    (unread > 0).then_some(i64::from(unread))
}

/// What a click on the window's close button does.
pub fn on_close(prefs: DesktopPrefs, has_tray: bool) -> CloseAction {
    if prefs.keep_running && has_tray {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// Where the first-time hint says the app went.
fn hint_text() -> &'static str {
    if cfg!(target_os = "macos") {
        "Ohiyo is still running in the menu bar."
    } else {
        "Ohiyo is still running in the tray."
    }
}

#[derive(Default)]
pub struct TrayState {
    has_tray: AtomicBool,
    in_call: AtomicBool,
    hidden: AtomicBool,
}

pub fn close_action(app: &AppHandle) -> CloseAction {
    let has_tray = app.state::<TrayState>().has_tray.load(Ordering::Relaxed);
    on_close(app.state::<PrefsState>().get(), has_tray)
}

/// The window is on screen again, however that happened. Tells the app once.
pub fn mark_visible(app: &AppHandle) {
    if app.state::<TrayState>().hidden.swap(false, Ordering::Relaxed) {
        let _ = app.emit(EVENT_WINDOW_HIDDEN, false);
    }
}

/// Show the window and bring it to the front: the tray's "Open Ohiyo", the Dock icon, a
/// second launch.
pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    mark_visible(app);
}

/// Hide to the tray and, the first time ever, say where Ohiyo went.
pub fn hide_main(app: &AppHandle) {
    // On a Mac hide the whole app, as Cmd+H does: then anything that activates Ohiyo
    // (the Dock, Cmd+Tab, a notification) brings the window back by itself.
    #[cfg(target_os = "macos")]
    let _ = app.hide();
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.hide();
        }
    }
    app.state::<TrayState>().hidden.store(true, Ordering::Relaxed);
    let _ = app.emit(EVENT_WINDOW_HIDDEN, true);
    let prefs = app.state::<PrefsState>();
    if !prefs.get().tray_hint_shown {
        prefs.update(|p| p.tray_hint_shown = true);
        let _ = app.notification().builder().title("Ohiyo").body(hint_text()).show();
    }
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn build_menu(app: &AppHandle, in_call: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Ohiyo", true, None::<&str>)?)?;
    // Only while in a call, so the menu never offers to leave nothing.
    if in_call {
        menu.append(&MenuItem::with_id(app, "leave_call", "Leave call", true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "check_updates", "Check for updates", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(app, "autostart", "Open at login", true, autostart_enabled(app), None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Ohiyo", true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuild the menu from what is true now (in a call or not, open at login or not).
fn refresh_menu(app: &AppHandle) {
    let in_call = app.state::<TrayState>().in_call.load(Ordering::Relaxed);
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app, in_call)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Turn open-at-login on or off. Returns what the system now says.
fn set_autostart(app: &AppHandle, enabled: bool) -> bool {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    if let Err(e) = result {
        eprintln!("[ohiyo] couldn't change open-at-login: {e}");
    }
    refresh_menu(app);
    autostart_enabled(app)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(0))
        .menu(&build_menu(app, false)?)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "leave_call" => {
                let _ = app.emit(EVENT_LEAVE_CALL, ());
            }
            "check_updates" => {
                show_main(app);
                let _ = app.emit(EVENT_CHECK_UPDATES, ());
            }
            "autostart" => {
                set_autostart(app, !autostart_enabled(app));
            }
            "quit" => app.exit(0),
            _ => {}
        });
    // The Mac menu bar wants a one-colour template image; other trays take the app icon.
    #[cfg(target_os = "macos")]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
        builder = builder.icon(icon).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }
    builder.build(app)?;
    Ok(())
}

pub fn init(app: &AppHandle) {
    app.manage(TrayState::default());
    match build_tray(app) {
        Ok(()) => app.state::<TrayState>().has_tray.store(true, Ordering::Relaxed),
        // No tray on this desktop: Ohiyo still runs, and closing the window quits.
        Err(e) => eprintln!("[ohiyo] couldn't create the tray icon: {e}"),
    }
}

#[tauri::command]
pub fn desktop_set_unread(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(count)));
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_badge_count(badge(count));
    }
}

#[tauri::command]
pub fn desktop_set_in_call(app: AppHandle, state: State<TrayState>, in_call: bool) {
    if state.in_call.swap(in_call, Ordering::Relaxed) != in_call {
        refresh_menu(&app);
    }
}

#[tauri::command]
pub fn desktop_autostart_get(app: AppHandle) -> bool {
    autostart_enabled(&app)
}

#[tauri::command]
pub fn desktop_autostart_set(app: AppHandle, enabled: bool) -> bool {
    set_autostart(&app, enabled)
}
```

Replace the whole of `client/src-tauri/src/lib.rs` with:

```rust
use tauri::Manager;

mod prefs;
mod tray;
mod vault;

/// Restart the app: "Try again" on the locked vault screen, and after a reset or burn.
/// `request_restart` goes through the normal exit (the Exit event), so plugins such as
/// single-instance clean up before the relaunch; `restart` from a command skips that and
/// the relaunched process could quit instead of starting.
#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered FIRST. A second launch (e.g. opening a
    // ohiyo:// invite link while the app is already running on Windows/Linux, or
    // starting Ohiyo again while it sits in the tray) brings the existing window
    // back instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                tray::show_main(app);
            }))
            .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            prefs::init(app.handle());
            // Locked-RAM E2E key vault (replaces on-disk localStorage for the keys).
            vault::init(app.handle());
            tray::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != tray::MAIN_WINDOW {
                return;
            }
            match event {
                // Closing hides Ohiyo to the tray when "keep running" is on.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if tray::close_action(window.app_handle()) == tray::CloseAction::Hide {
                        api.prevent_close();
                        tray::hide_main(window.app_handle());
                    }
                }
                tauri::WindowEvent::Focused(true) => tray::mark_visible(window.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_available,
            vault::vault_snapshot,
            vault::vault_set,
            vault::vault_remove,
            vault::vault_remove_many,
            vault::vault_reset,
            vault::vault_burn,
            prefs::desktop_prefs_get,
            prefs::desktop_prefs_set,
            tray::desktop_set_unread,
            tray::desktop_set_in_call,
            tray::desktop_autostart_get,
            tray::desktop_autostart_set,
            app_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ohiyo")
        .run(|app, event| {
            // A click on the Mac Dock icon.
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { .. } = event {
                    tray::show_main(app);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
```

- [ ] **Step 5: Run the tests and the crate check**

```bash
cd client/src-tauri
cargo test tray && cargo check --locked --all-targets && cargo test --locked
```
Expected: 5 tray tests pass; the check ends with no errors and no warnings from `src/`; the full run shows the tray, prefs and vault tests passing. If a call does not match the installed Tauri, read the signature in `~/.cargo/registry/src/*/tauri-2.11.*/src/` and adjust the call, keeping the behaviour above.

- [ ] **Step 6: Commit**

```bash
git add client/src-tauri/icons/tray.png client/src-tauri/src/tray.rs client/src-tauri/src/lib.rs client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock
git commit -m "feat(desktop): tray icon, close to tray, open at login"
```

---

### Task 4: The app tells the shell about unread, calls and the hidden window

**Files:**
- Create: `client/src/lib/unreadTotal.ts`, `client/src/lib/attention.ts`, `client/src/lib/desktopShell.ts`, `client/src/hooks/useDesktopShell.ts`
- Modify: `client/src/App.tsx`
- Test: `client/test/unreadTotal.test.ts`, `client/test/attention.test.ts`, `client/test/desktopShell.test.ts`, `client/test/fixtures/desktopShellEntry.ts`

**Interfaces:**
- Consumes: the commands and events from Tasks 2 and 3.
- Produces:
  - `unreadTotal(unread: Readonly<Record<string, number>>): number`, `withoutUnread(unread: Record<string, number>, channelId: string): Record<string, number>`
  - `isLookingAt(a: Attention): boolean`, `arrivalInOpenChat(isWindowHidden: boolean, isFromMe: boolean): "read" | "unread" | "nothing"`, `lastRealMessageId(msgs: readonly { id: string }[]): string | undefined`
  - from `desktopShell.ts`: `type DesktopPrefs = { keep_running: boolean; tray_hint_shown: boolean }`, `type ShellEvent = "leave-call" | "check-updates" | "window-hidden"`, `setUnreadBadge(count: number): Promise<void>`, `setInCall(inCall: boolean): Promise<void>`, `getDesktopPrefs(): Promise<DesktopPrefs | null>`, `setKeepRunning(on: boolean): Promise<DesktopPrefs | null>`, `getOpenAtLogin(): Promise<boolean>`, `setOpenAtLogin(on: boolean): Promise<boolean>`, `onShellEvent(name: ShellEvent, handler: (payload: unknown) => void): Promise<() => void>`
  - `useDesktopShell(options: { unread: number; inCall: boolean; onLeaveCall: () => void; onCheckUpdates: () => void; onWindowHidden: (hidden: boolean) => void }): void`

- [ ] **Step 1: Write the failing tests**

`client/test/unreadTotal.test.ts`:

```ts
// The number on the dock icon and in the tab title. It has to be a whole number whatever
// the server or a bug puts in the map.
//   node --experimental-strip-types --test test/unreadTotal.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { unreadTotal, withoutUnread } from "../src/lib/unreadTotal.ts";

test("it adds up every chat", () => {
  assert.equal(unreadTotal({}), 0);
  assert.equal(unreadTotal({ a: 2, b: 5 }), 7);
});

test("anything that is not a clean count is left out", () => {
  const odd = { a: 3, b: -4, c: Number.NaN, d: 2.7, e: Number.POSITIVE_INFINITY } as Record<string, number>;
  // 3, plus 2 from the 2.7; the rest count for nothing.
  assert.equal(unreadTotal(odd), 5);
  assert.equal(unreadTotal({ a: undefined as unknown as number, b: "9" as unknown as number }), 0);
});

test("marking a chat read removes it and leaves the others", () => {
  assert.deepEqual(withoutUnread({ a: 2, b: 5 }, "a"), { b: 5 });
});

test("marking a chat read that has nothing unread changes nothing", () => {
  const unread = { b: 5 };
  // The same object, so React skips the re-render.
  assert.equal(withoutUnread(unread, "a"), unread);
});
```

`client/test/attention.test.ts`:

```ts
// When does a new message count as seen? Only when its chat is open in a window the
// person can actually see. A desktop window hidden in the tray is not that.
//   node --experimental-strip-types --test test/attention.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { arrivalInOpenChat, isLookingAt, lastRealMessageId } from "../src/lib/attention.ts";

const open = { openChannelId: "c1", messageChannelId: "c1", pageHidden: false, windowHidden: false };

test("the chat is open and on screen", () => {
  assert.equal(isLookingAt(open), true);
});

test("another chat is open, or none", () => {
  assert.equal(isLookingAt({ ...open, openChannelId: "c2" }), false);
  assert.equal(isLookingAt({ ...open, openChannelId: null }), false);
  assert.equal(isLookingAt({ ...open, openChannelId: undefined }), false);
});

test("the chat is open but the tab is in the background", () => {
  assert.equal(isLookingAt({ ...open, pageHidden: true }), false);
});

test("the chat is open but the desktop window is hidden in the tray", () => {
  assert.equal(isLookingAt({ ...open, windowHidden: true }), false);
});

test("a message in the open chat is read when the window is on screen", () => {
  assert.equal(arrivalInOpenChat(false, false), "read");
  assert.equal(arrivalInOpenChat(false, true), "read");
});

test("a message in the open chat while the window is hidden counts as unread", () => {
  assert.equal(arrivalInOpenChat(true, false), "unread");
});

test("your own message from another device is never unread", () => {
  assert.equal(arrivalInOpenChat(true, true), "nothing");
});

test("the read mark is the newest message the server knows", () => {
  assert.equal(lastRealMessageId([{ id: "m1" }, { id: "m2" }, { id: "temp-3" }]), "m2");
  assert.equal(lastRealMessageId([{ id: "temp-1" }]), undefined);
  assert.equal(lastRealMessageId([]), undefined);
});
```

`client/test/fixtures/desktopShellEntry.ts`:

```ts
// Entry bundled by the desktop shell test, so the dynamic @tauri-apps imports resolve.
export * from "../../src/lib/desktopShell";
```

`client/test/desktopShell.test.ts`:

```ts
// The one module that talks to the desktop shell. In a browser every call does nothing
// and never throws; in the desktop app each one invokes the command the shell expects.
//   node --experimental-strip-types --test test/desktopShell.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Prefs = { keep_running: boolean; tray_hint_shown: boolean };
type Mod = {
  setUnreadBadge: (count: number) => Promise<void>;
  setInCall: (inCall: boolean) => Promise<void>;
  getDesktopPrefs: () => Promise<Prefs | null>;
  setKeepRunning: (on: boolean) => Promise<Prefs | null>;
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (on: boolean) => Promise<boolean>;
};
let bundle: Bundle<Mod>;
const g = globalThis as Record<string, unknown>;
let calls: Array<[string, unknown]> = [];
let answer: (cmd: string, args: unknown) => unknown = () => null;

function asDesktop(): void {
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown) => {
        calls.push([cmd, args]);
        return answer(cmd, args);
      },
    },
  };
}

before(async () => {
  g.window = {};
  bundle = await bundleEntry<Mod>(join(fixtures, "desktopShellEntry.ts"));
});
beforeEach(() => {
  calls = [];
  answer = () => null;
  g.window = {};
});
after(async () => {
  await bundle?.cleanup();
});

test("in a browser nothing is invoked and nothing throws", async () => {
  await bundle.mod.setUnreadBadge(3);
  await bundle.mod.setInCall(true);
  assert.equal(await bundle.mod.getDesktopPrefs(), null);
  assert.equal(await bundle.mod.setKeepRunning(true), null);
  assert.equal(await bundle.mod.getOpenAtLogin(), false);
  assert.equal(await bundle.mod.setOpenAtLogin(true), false);
  assert.deepEqual(calls, []);
});

test("in the desktop app the unread total and call state reach the shell", async () => {
  asDesktop();
  await bundle.mod.setUnreadBadge(4);
  await bundle.mod.setInCall(true);
  assert.deepEqual(calls, [["desktop_set_unread", { count: 4 }], ["desktop_set_in_call", { inCall: true }]]);
});

test("the badge is always a whole number of at least zero", async () => {
  asDesktop();
  for (const odd of [-2, 2.9, Number.NaN, Number.POSITIVE_INFINITY]) await bundle.mod.setUnreadBadge(odd);
  assert.deepEqual(calls.map(([, args]) => (args as { count: number }).count), [0, 2, 0, 0]);
});

test("prefs and open-at-login round trip through the shell", async () => {
  asDesktop();
  answer = (cmd, args) => {
    if (cmd === "desktop_prefs_get") return { keep_running: true, tray_hint_shown: false };
    if (cmd === "desktop_prefs_set") return { keep_running: (args as { keepRunning: boolean }).keepRunning, tray_hint_shown: false };
    if (cmd === "desktop_autostart_get") return true;
    if (cmd === "desktop_autostart_set") return (args as { enabled: boolean }).enabled;
    return null;
  };
  assert.deepEqual(await bundle.mod.getDesktopPrefs(), { keep_running: true, tray_hint_shown: false });
  assert.deepEqual(await bundle.mod.setKeepRunning(false), { keep_running: false, tray_hint_shown: false });
  assert.equal(await bundle.mod.getOpenAtLogin(), true);
  assert.equal(await bundle.mod.setOpenAtLogin(false), false);
});

test("a shell that fails does not break the app", async () => {
  asDesktop();
  answer = () => {
    throw new Error("command not found");
  };
  await bundle.mod.setUnreadBadge(1);
  assert.equal(await bundle.mod.getDesktopPrefs(), null);
  assert.equal(await bundle.mod.getOpenAtLogin(), false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd client && node --experimental-strip-types --test test/unreadTotal.test.ts test/attention.test.ts test/desktopShell.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the pure helpers, the shell module and the hook**

`client/src/lib/unreadTotal.ts`:

```ts
// The unread map (chat id → count). Pure, for unit tests.

/** Total unread across every chat, as a whole number of at least zero. */
export function unreadTotal(unread: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(unread)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) total += Math.floor(count);
  }
  return total;
}

/** The map with one chat marked read. The same object when that chat had nothing unread. */
export function withoutUnread(unread: Record<string, number>, channelId: string): Record<string, number> {
  if (!unread[channelId]) return unread;
  const next = { ...unread };
  delete next[channelId];
  return next;
}
```

`client/src/lib/attention.ts`:

```ts
// When a new message counts as seen. Pure, for unit tests.

export interface Attention {
  /** The chat that is open, if any. */
  openChannelId: string | null | undefined;
  /** The chat the message arrived in. */
  messageChannelId: string;
  /** The tab or page is in the background. */
  pageHidden: boolean;
  /** The desktop window is hidden in the tray. Always false in a browser. */
  windowHidden: boolean;
}

/** True only when the message's chat is open in a window the person can see. */
export function isLookingAt({ openChannelId, messageChannelId, pageHidden, windowHidden }: Attention): boolean {
  return openChannelId === messageChannelId && !pageHidden && !windowHidden;
}

/**
 * A message arrived in the chat that is open. With the window on screen it is read.
 * With the window hidden in the tray nobody has seen it: it is unread, unless it is
 * your own message from another device.
 */
export function arrivalInOpenChat(isWindowHidden: boolean, isFromMe: boolean): "read" | "unread" | "nothing" {
  if (!isWindowHidden) return "read";
  return isFromMe ? "nothing" : "unread";
}

/** Newest non-optimistic message id in a list — the read watermark. */
export function lastRealMessageId(msgs: readonly { id: string }[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].id.startsWith("temp-")) return msgs[i].id;
  }
  return undefined;
}
```

`client/src/lib/desktopShell.ts`:

```ts
// The app's side of the desktop shell: the tray, the dock badge, the close-to-tray
// setting and open-at-login. Every export does nothing in a browser and never throws,
// so callers need no checks. The commands are in client/src-tauri/src/{tray,prefs}.rs.
import { isDesktop } from "./desktop";

export type DesktopPrefs = { keep_running: boolean; tray_hint_shown: boolean };
export type ShellEvent = "leave-call" | "check-updates" | "window-hidden";

async function call<T>(command: string, args: Record<string, unknown> | undefined, fallback: T): Promise<T> {
  if (!isDesktop()) return fallback;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<T>(command, args)) ?? fallback;
  } catch (err) {
    console.warn(`[ohiyo] desktop shell: ${command} failed`, err);
    return fallback;
  }
}

/** A whole number of at least zero, whatever was passed in. */
function wholeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** The number on the dock icon and in the tray tooltip. */
export async function setUnreadBadge(count: number): Promise<void> {
  await call<null>("desktop_set_unread", { count: wholeCount(count) }, null);
}

/** Whether the tray menu offers "Leave call". */
export async function setInCall(inCall: boolean): Promise<void> {
  await call<null>("desktop_set_in_call", { inCall }, null);
}

export function getDesktopPrefs(): Promise<DesktopPrefs | null> {
  return call<DesktopPrefs | null>("desktop_prefs_get", undefined, null);
}

export function setKeepRunning(on: boolean): Promise<DesktopPrefs | null> {
  return call<DesktopPrefs | null>("desktop_prefs_set", { keepRunning: on }, null);
}

export function getOpenAtLogin(): Promise<boolean> {
  return call<boolean>("desktop_autostart_get", undefined, false);
}

/** Returns what the operating system now says, which can differ from what was asked. */
export function setOpenAtLogin(on: boolean): Promise<boolean> {
  return call<boolean>("desktop_autostart_set", { enabled: on }, false);
}

/** Listen for something the shell tells the app. Resolves to a function that stops listening. */
export async function onShellEvent(name: ShellEvent, handler: (payload: unknown) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen(`desktop://${name}`, (event) => handler(event.payload));
  } catch (err) {
    console.warn(`[ohiyo] desktop shell: couldn't listen for ${name}`, err);
    return () => {};
  }
}
```

`client/src/hooks/useDesktopShell.ts`:

```ts
import { useEffect, useRef } from "react";
import { onShellEvent, setInCall, setUnreadBadge } from "../lib/desktopShell";

type Options = {
  /** Total unread across every chat. */
  unread: number;
  inCall: boolean;
  /** "Leave call" was chosen in the tray menu. */
  onLeaveCall: () => void;
  /** "Check for updates" was chosen in the tray menu. */
  onCheckUpdates: () => void;
  /** The window was hidden to the tray (true) or is back on screen (false). */
  onWindowHidden: (hidden: boolean) => void;
};

/** Keeps the desktop shell in step with the app. Does nothing in a browser. */
export function useDesktopShell({ unread, inCall, onLeaveCall, onCheckUpdates, onWindowHidden }: Options): void {
  useEffect(() => {
    void setUnreadBadge(unread);
  }, [unread]);

  useEffect(() => {
    void setInCall(inCall);
  }, [inCall]);

  // The handlers change every render; the listeners are set up once and read the latest.
  const handlers = useRef({ onLeaveCall, onCheckUpdates, onWindowHidden });
  useEffect(() => {
    handlers.current = { onLeaveCall, onCheckUpdates, onWindowHidden };
  });

  useEffect(() => {
    let isStopped = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (isStopped) stop();
      else stops.push(stop);
    };
    void onShellEvent("leave-call", () => handlers.current.onLeaveCall()).then(keep);
    void onShellEvent("check-updates", () => handlers.current.onCheckUpdates()).then(keep);
    void onShellEvent("window-hidden", (hidden) => handlers.current.onWindowHidden(hidden === true)).then(keep);
    return () => {
      isStopped = true;
      for (const stop of stops) stop();
    };
  }, []);
}
```

- [ ] **Step 4: Use them in `App.tsx`**

Add imports next to the other `./lib/` and `./hooks/` imports:

```ts
import { arrivalInOpenChat, isLookingAt, lastRealMessageId } from "./lib/attention";
import { unreadTotal, withoutUnread } from "./lib/unreadTotal";
import { useDesktopShell } from "./hooks/useDesktopShell";
```

Delete the in-component copy of `lastRealMessageId` (it moved to `lib/attention.ts` unchanged; its one existing caller keeps working through the import):

```ts
  /** Newest non-optimistic message id in a list — the read watermark. */
  function lastRealMessageId(msgs: Message[]): string | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i].id.startsWith("temp-")) return msgs[i].id;
    }
    return undefined;
  }
```

Directly after the line `const webrtc = liveKitEnabled ? sfu : mesh;` add:

```ts
  // ── Desktop shell: the tray, the dock badge, and a window that can sit hidden ──
  const totalUnread = unreadTotal(unread);
  // A window hidden in the tray is never "looking at" a chat: messages there notify and
  // count as unread, and are marked read when the window comes back.
  const windowHiddenRef = useRef(false);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastMessageIdRef.current = lastRealMessageId(messages);
  }, [messages]);
  useDesktopShell({
    unread: totalUnread,
    inCall: webrtc.channelId !== null,
    onLeaveCall: () => {
      if (webrtc.channelId !== null) webrtc.hangUp();
    },
    onCheckUpdates: () => {},
    onWindowHidden: (hidden) => {
      windowHiddenRef.current = hidden;
      const open = selectedChannelRef.current;
      if (hidden || !open) return;
      // Back on screen: what arrived in the open chat while hidden is now read.
      sendAck(open.id, lastMessageIdRef.current);
      setUnread((prev) => withoutUnread(prev, open.id));
    },
  });
```

(`onCheckUpdates` is filled in by Task 6.)

Replace the unread title effect

```ts
  useEffect(() => {
    const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) Ohiyo` : "Ohiyo";
  }, [unread]);
```

with

```ts
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Ohiyo` : "Ohiyo";
  }, [totalUnread]);
```

In the `MessageCreate` case, replace

```ts
          // You're looking at this channel → it's read. Advance the cursor.
          sendAck(msg.channel_id, msg.id);
```

with

```ts
          const isFromMe = !currentUserRef.current || msg.author.id === currentUserRef.current.id;
          const arrival = arrivalInOpenChat(windowHiddenRef.current, isFromMe);
          // You're looking at this channel → it's read. Advance the cursor.
          if (arrival === "read") sendAck(msg.channel_id, msg.id);
          // The window is hidden in the tray: it arrived, but nobody has seen it yet.
          if (arrival === "unread") setUnread((prev) => ({ ...prev, [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1 }));
```

In `maybeNotify`, replace

```ts
    const lookingAtIt =
      selectedChannelRef.current?.id === msg.channel_id && !document.hidden;
```

with

```ts
    const lookingAtIt = isLookingAt({
      openChannelId: selectedChannelRef.current?.id,
      messageChannelId: msg.channel_id,
      pageHidden: document.hidden,
      windowHidden: windowHiddenRef.current,
    });
```

- [ ] **Step 5: Run everything for this task**

Run: `cd client && node --experimental-strip-types --test test/unreadTotal.test.ts test/attention.test.ts test/desktopShell.test.ts && npx tsc --noEmit && npm run -s lint`
Expected: 17 tests pass; no type or lint output.

Then the browser must behave as before. With the local stack running (Global Constraints): `KIKKA_ORIGIN=http://localhost:1420 node e2e/run.mjs 03-alive` and `… node e2e/run.mjs 17-receipts`. Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/unreadTotal.ts client/src/lib/attention.ts client/src/lib/desktopShell.ts client/src/hooks/useDesktopShell.ts client/src/App.tsx client/test/unreadTotal.test.ts client/test/attention.test.ts client/test/desktopShell.test.ts client/test/fixtures/desktopShellEntry.ts
git commit -m "feat(desktop): unread badge, call state and the hidden window reach the shell"
```

---

### Task 5: The "Desktop app" settings card, and one sentence to correct

**Files:**
- Create: `client/src/components/settings/DesktopAppCard.tsx`
- Modify: `client/src/components/settings/SettingsModal.tsx` (`NotificationsTab`)
- Modify: `client/test/appWording.test.ts`
- Test: `client/test/desktopSettings.test.ts`

**Interfaces:**
- Consumes: `getDesktopPrefs`, `setKeepRunning`, `getOpenAtLogin`, `setOpenAtLogin` (Task 4); the `.kc-switch` styles already in `client/src/index.css`; `isDesktop` (already imported in `SettingsModal.tsx`).
- Produces: `<DesktopAppCard onToast={…} />`.

- [ ] **Step 1: Write the failing test**

`client/test/desktopSettings.test.ts`:

```ts
// Settings → Notifications. The desktop app gets a card with its two switches; a browser
// does not. And the page must not claim that every notification hides message text.
//   node --experimental-strip-types --test test/desktopSettings.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { renderSettingsModal: (props: Record<string, unknown>) => string };
let bundle: Bundle<Mod>;
const g = globalThis as Record<string, unknown>;

before(async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.window = globalThis;
  g.document = { documentElement: { style: {} } };
  bundle = await bundleEntry<Mod>(join(fixtures, "renderSettingsModal.tsx"), [
    { find: /^@privacyresearch\/libsignal-protocol-typescript$/, replacement: join(fixtures, "libsignalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

function notificationsTab(): string {
  return bundle.mod.renderSettingsModal({
    currentUser: null,
    pluginManager: {},
    token: "t",
    servers: [],
    dms: [],
    initialTab: "notifications",
    onClose() {},
    onToast() {},
    privacyPrefs: { metadataMode: false },
    onPrivacyPrefsChange() {},
  });
}

test("a browser shows no desktop card", () => {
  assert.doesNotMatch(notificationsTab(), /Desktop app|Keep running when I close the window/);
});

test("the desktop app shows the card with two named switches", () => {
  g.__TAURI_INTERNALS__ = { invoke: async () => null };
  try {
    const html = notificationsTab();
    assert.match(html, /Desktop app/);
    for (const name of ["Keep running when I close the window", "Open Ohiyo when I log in"]) {
      assert.match(html, new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${name}"`), name);
    }
  } finally {
    delete g.__TAURI_INTERNALS__;
  }
});

test("the page says which notifications carry message text", () => {
  const html = notificationsTab();
  assert.doesNotMatch(html, /A notification never includes/);
  assert.match(html, /Push notifications, which reach you when Ohiyo is closed, never include/);
  assert.match(html, /show who wrote and the start of the message, except in encrypted chats/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd client && node --experimental-strip-types --test test/desktopSettings.test.ts`
Expected: the second and third tests FAIL.

- [ ] **Step 3: Implement**

`client/src/components/settings/DesktopAppCard.tsx`:

```tsx
import { useEffect, useState } from "react";
import { getDesktopPrefs, getOpenAtLogin, setKeepRunning, setOpenAtLogin } from "../../lib/desktopShell";

type Props = {
  onToast: (text: string, type?: "info" | "success" | "error") => void;
};

type RowProps = {
  name: string;
  hint: string;
  /** Null until the shell has answered. */
  isOn: boolean | null;
  onToggle: () => void;
};

function SwitchRow({ name, hint, isOn, onToggle }: RowProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{name}</div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={isOn === true} aria-label={name} disabled={isOn === null} onClick={onToggle} className="kc-switch">
        <span className="kc-switch__knob" />
      </button>
    </div>
  );
}

/** The two switches only the desktop app has. Shown inside Settings → Notifications. */
export function DesktopAppCard({ onToast }: Props) {
  const [keepRunning, setKeepRunningState] = useState<boolean | null>(null);
  const [openAtLogin, setOpenAtLoginState] = useState<boolean | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void getDesktopPrefs().then((prefs) => {
      if (isCurrent && prefs) setKeepRunningState(prefs.keep_running);
    });
    void getOpenAtLogin().then((on) => {
      if (isCurrent) setOpenAtLoginState(on);
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  async function toggleKeepRunning() {
    const prefs = await setKeepRunning(!keepRunning);
    if (!prefs) {
      onToast("Couldn't save that setting.", "error");
      return;
    }
    setKeepRunningState(prefs.keep_running);
  }

  async function toggleOpenAtLogin() {
    const wanted = !openAtLogin;
    const now = await setOpenAtLogin(wanted);
    setOpenAtLoginState(now);
    if (now !== wanted) onToast("Your system didn't allow that change.", "error");
  }

  return (
    <div className="mb-6 grid gap-4 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
      <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Desktop app</div>
      <SwitchRow
        name="Keep running when I close the window"
        hint="Ohiyo stays in the tray, so notifications keep arriving. Quit from the tray menu."
        isOn={keepRunning}
        onToggle={() => void toggleKeepRunning()}
      />
      <SwitchRow
        name="Open Ohiyo when I log in"
        hint="Starts Ohiyo with your computer."
        isOn={openAtLogin}
        onToggle={() => void toggleOpenAtLogin()}
      />
    </div>
  );
}
```

In `client/src/components/settings/SettingsModal.tsx`:

Under the `PluginsTab` import add:

```ts
import { DesktopAppCard } from "./DesktopAppCard";
```

In `NotificationsTab`, replace

```tsx
        Get a nudge when something new arrives. A notification never includes message text, file names, channel names or encryption keys.
      </p>
```

with

```tsx
        Get a nudge when something new arrives. Notifications while Ohiyo is running show who wrote and the start of the message, except in encrypted chats. Push notifications, which reach you when Ohiyo is closed, never include message text, file names, channel names or encryption keys.
      </p>

      {isDesktop() && <DesktopAppCard onToast={onToast} />}
```

In `client/test/appWording.test.ts`, add to the `UNTRUE` list:

```ts
  // True of push only. A notification shown while Ohiyo runs carries the start of the message.
  "A notification never includes",
```

- [ ] **Step 4: Run the tests, type check, lint**

Run: `cd client && node --experimental-strip-types --test test/desktopSettings.test.ts test/appWording.test.ts test/fieldLimits.test.ts && npx tsc --noEmit && npx eslint src/components/settings`
Expected: all pass; no type or lint output.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/DesktopAppCard.tsx client/src/components/settings/SettingsModal.tsx client/test/desktopSettings.test.ts client/test/appWording.test.ts
git commit -m "feat(desktop): settings for keep running and open at login; say which notifications carry message text"
```

---

### Task 6: Updates

**Files:**
- Modify: `client/src-tauri/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `tauri.conf.json`, `capabilities/default.json`
- Modify: `client/package.json`, `client/package-lock.json`
- Create: `client/src/lib/appUpdate.ts`, `client/src/hooks/useAppUpdate.ts`, `client/src/components/UpdateBar.tsx`
- Modify: `client/src/lib/desktopShell.ts`, `client/src/App.tsx`, `client/src/index.css`
- Modify: `.github/workflows/release.yml`, `DEPLOY.md`
- Test: `client/test/appUpdate.test.ts`, `client/test/updateBar.test.ts`, `client/test/fixtures/renderUpdateBar.tsx`; extend `client/test/desktopShell.test.ts`, `client/test/desktopBundle.test.ts`

**Interfaces:**
- Produces:
  - `appUpdate.ts`: `UPDATE_CHECK_INTERVAL_MS: number`, `updateReadyLabel(version: string): string`, `type UpdateCheckOutcome = { kind: "available"; version: string } | { kind: "current" } | { kind: "failed" }`, `updateCheckMessage(outcome: UpdateCheckOutcome, isManual: boolean): string | null`, `showsUpdateBar(isManual: boolean, wasDismissed: boolean): boolean`
  - `desktopShell.ts`: `type AppUpdate = { version: string; install: () => Promise<void> }`, `checkForUpdate(): Promise<AppUpdate | null>` (rejects when the check itself fails)
  - `useAppUpdate(options: { isSignedIn: boolean; onMessage: (text: string, type: "info" | "error") => void }): { update: AppUpdate | null; isInstalling: boolean; check: (isManual: boolean) => Promise<void>; install: () => Promise<void>; dismiss: () => void }`
  - `<UpdateBar version isInstalling onInstall onLater />`

- [ ] **Step 1: Make the update key (never printed)**

```bash
KEYDIR="$HOME/Desktop/ohiyo-update-key"
[ -e "$KEYDIR/ohiyo-updater.key" ] && { echo "a key already exists: stop and ask the owner"; exit 1; }
mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"
openssl rand -base64 30 | tr -d '\n' > "$KEYDIR/password.txt"
cd ~/Documents/Projects/oHiYo/client
npm run -s tauri signer generate -- --ci -p "$(cat "$KEYDIR/password.txt")" -w "$KEYDIR/ohiyo-updater.key" > /dev/null
chmod 600 "$KEYDIR"/*
ls "$KEYDIR"            # ohiyo-updater.key  ohiyo-updater.key.pub  password.txt
cat > "$KEYDIR/READ-ME.txt" <<'EOF'
These files sign Ohiyo desktop updates.

ohiyo-updater.key      the private key. Whoever has it can ship an update to every
                       installed copy of Ohiyo. Keep it secret.
password.txt           the password for that key.
ohiyo-updater.key.pub  the public half. It is in the app already; not secret.

Leave this folder here until the 0.3.0 release is published: it is needed to build the
test versions. After that, move the private key and the password into your password
manager and delete the folder. GitHub has its own copy for building releases, but
GitHub will never show it to you again. If both copies are lost, installed apps can
no longer be updated.
EOF
tr -d '\n' < "$KEYDIR/ohiyo-updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo New1Direction/ohiyo
tr -d '\n' < "$KEYDIR/password.txt" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo New1Direction/ohiyo
gh secret list --repo New1Direction/ohiyo | awk '{print $1}'   # both names are listed
```

Only the `.pub` file may be read into the repo. Never `cat` the other two to the terminal.

- [ ] **Step 2: Write the failing tests**

`client/test/appUpdate.test.ts`:

```ts
// What the app says about updates. Checks it starts by itself stay quiet unless there is
// something to install; a check the person asked for always gets an answer.
//   node --experimental-strip-types --test test/appUpdate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { UPDATE_CHECK_INTERVAL_MS, showsUpdateBar, updateCheckMessage, updateReadyLabel } from "../src/lib/appUpdate.ts";

test("the bar names the version that is ready", () => {
  assert.equal(updateReadyLabel("0.3.1"), "Ohiyo 0.3.1 is ready");
});

test("the app looks for updates every six hours", () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("a check the app started says nothing; an available update is announced by the bar", () => {
  assert.equal(updateCheckMessage({ kind: "current" }, false), null);
  assert.equal(updateCheckMessage({ kind: "failed" }, false), null);
  assert.equal(updateCheckMessage({ kind: "available", version: "0.3.1" }, false), null);
});

test("a check the person asked for always answers", () => {
  assert.equal(updateCheckMessage({ kind: "current" }, true), "Ohiyo is up to date.");
  assert.equal(updateCheckMessage({ kind: "failed" }, true), "Couldn't check for updates. Try again later.");
  assert.equal(updateCheckMessage({ kind: "available", version: "0.3.1" }, true), null);
});

test("after Later the bar stays away until the next start, unless the person asks", () => {
  assert.equal(showsUpdateBar(false, false), true);
  assert.equal(showsUpdateBar(false, true), false);
  assert.equal(showsUpdateBar(true, true), true);
});
```

`client/test/fixtures/renderUpdateBar.tsx`:

```tsx
// Entry bundled by the update bar test: renders the bar to static HTML.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBar } from "../../src/components/UpdateBar";

export function renderUpdateBar(props: ComponentProps<typeof UpdateBar>): string {
  return renderToStaticMarkup(<UpdateBar {...props} />);
}
```

`client/test/updateBar.test.ts`:

```ts
// The bar that offers a new version. It asks; it never installs by itself.
//   node --experimental-strip-types --test test/updateBar.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Props = { version: string; isInstalling: boolean; onInstall: () => void; onLater: () => void };
type Mod = { renderUpdateBar: (props: Props) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderUpdateBar.tsx"));
});
after(async () => {
  await bundle?.cleanup();
});

const idle: Props = { version: "0.3.1", isInstalling: false, onInstall() {}, onLater() {} };

test("it names the version and offers both choices", () => {
  const html = bundle.mod.renderUpdateBar(idle);
  assert.match(html, /role="status"/);
  assert.match(html, /Ohiyo 0\.3\.1 is ready/);
  assert.match(html, /<button[^>]*>Update now<\/button>/);
  assert.match(html, /<button[^>]*>Later<\/button>/);
});

test("while installing, the choices are replaced by what is happening", () => {
  const html = bundle.mod.renderUpdateBar({ ...idle, isInstalling: true });
  assert.match(html, /Updating… Ohiyo will restart\./);
  assert.doesNotMatch(html, /Update now|Later/);
});
```

In `client/test/desktopShell.test.ts`, add to the `Mod` type:

```ts
  checkForUpdate: () => Promise<{ version: string; install: () => Promise<void> } | null>;
```

and append:

```ts
test("a browser never checks for desktop updates", async () => {
  assert.equal(await bundle.mod.checkForUpdate(), null);
  assert.deepEqual(calls, []);
});

test("an update check tells a newer version from none, and from not being able to check", async () => {
  asDesktop();
  answer = (cmd) => (cmd === "plugin:updater|check" ? { rid: 7, currentVersion: "0.3.0", version: "0.3.1", rawJson: {} } : null);
  assert.equal((await bundle.mod.checkForUpdate())?.version, "0.3.1");
  answer = () => null;
  assert.equal(await bundle.mod.checkForUpdate(), null);
  // No network, or the release server is down: the caller must be able to tell.
  answer = () => {
    throw new Error("error sending request");
  };
  await assert.rejects(bundle.mod.checkForUpdate());
});
```

Append to `client/test/desktopBundle.test.ts`:

```ts
test("updates come from the newest published release and must carry our signature", () => {
  assert.deepEqual(conf.plugins.updater.endpoints, ["https://github.com/New1Direction/ohiyo/releases/latest/download/latest.json"]);
  // A minisign public key, base64. Without it the app would accept any update.
  assert.match(conf.plugins.updater.pubkey, /^[A-Za-z0-9+/=]{80,}$/);
  const capabilities = JSON.parse(read("capabilities/default.json"));
  assert.ok(capabilities.permissions.includes("updater:default"));
});

test("a plain local build needs no signing key: only the release workflow makes update bundles", () => {
  assert.equal(conf.bundle.createUpdaterArtifacts, undefined);
  const workflow = readFileSync(join(tauri, "..", "..", ".github", "workflows", "release.yml"), "utf8");
  assert.ok(workflow.includes("c.bundle.createUpdaterArtifacts=true"), "the workflow switches update bundles on");
  const builds = workflow.split("uses: tauri-apps/tauri-action@").length - 1;
  assert.equal(builds, 3, "Mac signed, Mac ad-hoc and Linux");
  assert.equal(workflow.split("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}").length - 1, builds);
  assert.equal(workflow.split("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}").length - 1, builds);
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `cd client && node --experimental-strip-types --test test/appUpdate.test.ts test/updateBar.test.ts test/desktopShell.test.ts test/desktopBundle.test.ts`
Expected: FAIL (modules not found; `checkForUpdate is not a function`; no `plugins.updater`).

- [ ] **Step 4: Implement the shell side**

```bash
cd ~/Documents/Projects/oHiYo/client
npm install @tauri-apps/plugin-updater@^2
```

`client/src-tauri/Cargo.toml`, under the autostart line added in Task 3:

```toml
# The app offers its own updates. Desktop only.
tauri-plugin-updater = "2"
```

`client/src-tauri/src/lib.rs`: in the `#[cfg(desktop)]` block, after the autostart `.plugin(…)` call and before the `;`, add

```rust
            .plugin(tauri_plugin_updater::Builder::new().build())
```

`client/src-tauri/capabilities/default.json`: add `"updater:default"` as the last entry of `permissions`.

`client/src-tauri/tauri.conf.json`, by script so the public key is copied exactly and the file's formatting is kept:

```bash
cd ~/Documents/Projects/oHiYo/client/src-tauri
python3 - <<'EOF'
from pathlib import Path

conf_path = Path("tauri.conf.json")
pubkey = (Path.home() / "Desktop/ohiyo-update-key/ohiyo-updater.key.pub").read_text().strip()
anchor = '  "plugins": {\n'
updater = (
    '    "updater": {\n'
    f'      "pubkey": "{pubkey}",\n'
    '      "endpoints": ["https://github.com/New1Direction/ohiyo/releases/latest/download/latest.json"]\n'
    "    },\n"
)
text = conf_path.read_text()
if text.count(anchor) != 1:
    raise SystemExit("tauri.conf.json: expected exactly one plugins block")
conf_path.write_text(text.replace(anchor, anchor + updater))
EOF
git diff --stat tauri.conf.json    # 1 file changed, 4 insertions
```

`.github/workflows/release.yml`:

Under the job's `env:` (below the `HAS_APPLE_SIGNING` line) add:

```yaml
      HAS_UPDATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}
```

After the `Install client dependencies` step add:

```yaml
      - name: Turn on signed update bundles
        if: env.HAS_UPDATE_KEY == 'true'
        working-directory: client
        run: |
          node -e "const fs=require('fs'); const p='src-tauri/tauri.conf.json'; const c=JSON.parse(fs.readFileSync(p,'utf8')); c.bundle.createUpdaterArtifacts=true; fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');"

      - name: Warn when update bundles are unavailable
        if: env.HAS_UPDATE_KEY != 'true'
        run: |
          echo "::warning::TAURI_SIGNING_PRIVATE_KEY is not set. Building installers without update bundles, so installed copies cannot be offered this release. See DEPLOY.md §5."
```

In each of the three `tauri-apps/tauri-action@v0` steps, add to `env:` directly under the `VITE_SERVER_URL` line:

```yaml
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

Then: `cd client/src-tauri && cargo check --all-targets` (no `--locked` this once: it adds the updater to `Cargo.lock`), then `cargo test --locked`. Expected: no errors; all tests pass.

- [ ] **Step 5: Implement the app side**

`client/src/lib/appUpdate.ts`:

```ts
// What the app says about updates. Pure, for unit tests.

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateCheckOutcome = { kind: "available"; version: string } | { kind: "current" } | { kind: "failed" };

export function updateReadyLabel(version: string): string {
  return `Ohiyo ${version} is ready`;
}

/**
 * The toast for a finished check, or null for none. An available update is announced by
 * the bar. Checks the app starts by itself stay silent; one the person asked for answers.
 */
export function updateCheckMessage(outcome: UpdateCheckOutcome, isManual: boolean): string | null {
  if (outcome.kind === "available" || !isManual) return null;
  return outcome.kind === "current" ? "Ohiyo is up to date." : "Couldn't check for updates. Try again later.";
}

/** "Later" hides the bar until the next start, unless the person asks again. */
export function showsUpdateBar(isManual: boolean, wasDismissed: boolean): boolean {
  return isManual || !wasDismissed;
}
```

Append to `client/src/lib/desktopShell.ts`:

```ts
export type AppUpdate = {
  version: string;
  /** Download, install and restart. Rejects if any step fails. */
  install: () => Promise<void>;
};

/**
 * Ask the release server for a newer version. Null when this copy is current or when not
 * running as the desktop app. Unlike the calls above, this one rejects when the check
 * itself fails, so the caller can tell "up to date" from "couldn't check".
 */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!isDesktop()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    install: async () => {
      await update.downloadAndInstall();
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_restart");
    },
  };
}
```

`client/src/hooks/useAppUpdate.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { UPDATE_CHECK_INTERVAL_MS, showsUpdateBar, updateCheckMessage, type UpdateCheckOutcome } from "../lib/appUpdate";
import { isDesktop } from "../lib/desktop";
import { checkForUpdate, type AppUpdate } from "../lib/desktopShell";

type Options = {
  /** Checks start once someone is signed in. */
  isSignedIn: boolean;
  /** Says something to the person: the answer to a check they asked for, or a failed install. */
  onMessage: (text: string, type: "info" | "error") => void;
};

/** Desktop updates: the app looks, the person decides. Does nothing in a browser. */
export function useAppUpdate({ isSignedIn, onMessage }: Options) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const wasDismissedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const check = useCallback(async (isManual: boolean) => {
    let outcome: UpdateCheckOutcome;
    try {
      const found = await checkForUpdate();
      setUpdate(found && showsUpdateBar(isManual, wasDismissedRef.current) ? found : null);
      outcome = found ? { kind: "available", version: found.version } : { kind: "current" };
    } catch (err) {
      console.warn("[ohiyo] update check failed", err);
      outcome = { kind: "failed" };
    }
    const message = updateCheckMessage(outcome, isManual);
    if (message) onMessageRef.current(message, outcome.kind === "failed" ? "error" : "info");
  }, []);

  useEffect(() => {
    if (!isDesktop() || !isSignedIn) return;
    void check(false);
    const timer = setInterval(() => void check(false), UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isSignedIn, check]);

  const install = useCallback(async () => {
    if (!update) return;
    setIsInstalling(true);
    try {
      await update.install();
    } catch (err) {
      console.warn("[ohiyo] update failed", err);
      setIsInstalling(false);
      onMessageRef.current("The update couldn't be installed. Try again later.", "error");
    }
  }, [update]);

  const dismiss = useCallback(() => {
    wasDismissedRef.current = true;
    setUpdate(null);
  }, []);

  return { update, isInstalling, check, install, dismiss };
}
```

`client/src/components/UpdateBar.tsx`:

```tsx
import { updateReadyLabel } from "../lib/appUpdate";

type Props = {
  version: string;
  isInstalling: boolean;
  onInstall: () => void;
  onLater: () => void;
};

/** Offers a new version of the desktop app. It asks first; it never installs by itself. */
export function UpdateBar({ version, isInstalling, onInstall, onLater }: Props) {
  return (
    <div className="kc-update-bar" role="status">
      {isInstalling ? (
        <span>Updating… Ohiyo will restart.</span>
      ) : (
        <>
          <span className="kc-update-bar__text">{updateReadyLabel(version)}</span>
          <button type="button" className="kc-update-bar__go" onClick={onInstall}>Update now</button>
          <button type="button" className="kc-update-bar__later" onClick={onLater}>Later</button>
        </>
      )}
    </div>
  );
}
```

In `client/src/index.css`, directly above the `/* ─── On/off switch (Plugins settings)` comment:

```css
/* ─── Update bar (desktop app) ───────────────────────────────────────────────── */
.kc-update-bar {
  position: fixed;
  top: 12px;
  left: 50%;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 24px);
  padding: 8px 10px 8px 16px;
  border-radius: 999px;
  background: var(--bg-sidebar);
  border: 1px solid var(--accent);
  box-shadow: 0 14px 34px -18px rgb(0 0 0 / 60%);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  transform: translateX(-50%);
}
.kc-update-bar__text { white-space: nowrap; }
.kc-update-bar__go,
.kc-update-bar__later { padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; cursor: pointer; }
.kc-update-bar__go { background: var(--accent); color: #fff; }
.kc-update-bar__later { background: var(--bg-input); color: var(--text-secondary); }
.kc-update-bar__later:hover { color: var(--text-primary); background: var(--bg-hover); }
```

In `client/src/App.tsx`:

Imports:

```ts
import { useAppUpdate } from "./hooks/useAppUpdate";
import { UpdateBar } from "./components/UpdateBar";
```

Directly above the `useDesktopShell({` call from Task 4:

```ts
  const appUpdate = useAppUpdate({ isSignedIn: currentUser !== null, onMessage: toast });
```

In that `useDesktopShell` call, replace `onCheckUpdates: () => {},` with:

```ts
    onCheckUpdates: () => void appUpdate.check(true),
```

Directly after `<ToastStack toasts={toasts} />`:

```tsx
      {appUpdate.update && (
        <UpdateBar
          version={appUpdate.update.version}
          isInstalling={appUpdate.isInstalling}
          onInstall={() => void appUpdate.install()}
          onLater={appUpdate.dismiss}
        />
      )}
```

- [ ] **Step 6: Bring DEPLOY.md in line**

In `DEPLOY.md`, replace the bullet

```markdown
- **Signing:** unsigned installers for now; the seam for signing/auto-update is
  wired and documented in [§5](#5-code-signing--auto-update-the-later-path).
```

with

```markdown
- **Signing:** Mac installers are ad-hoc signed for now (not Apple-notarized); see
  [§5](#5-code-signing--auto-update-the-later-path). Auto-update is on and has its own key.
```

and replace the whole `### Auto-update (silent, Discord-style)` subsection (its heading through the line before the `---` that precedes `## 6. CI/CD`) with:

```markdown
### Auto-update (on since 0.3.0)

The desktop app asks the newest **published** GitHub release for `latest.json` and offers
the update; the person chooses when to install it. A draft release is invisible to it.

Updates are signed with a key made for this purpose (it is not a code-signing certificate):

| GitHub secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The private update key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

The public half is `plugins.updater.pubkey` in `client/src-tauri/tauri.conf.json`. Keep a
copy of the private key and its password outside GitHub: without them, installed copies
can no longer be updated.

Update bundles are made only by the release workflow, which switches
`bundle.createUpdaterArtifacts` on when the key is present. A plain `npm run tauri build`
needs no key and makes no update bundle.

Running your own fork? Make your own pair with `npm run tauri signer generate -- -w <file>`,
put its public key and your release address in `plugins.updater`, and set the two secrets.
Otherwise your builds would look for updates in this repository and reject them.

Only the Linux AppImage updates itself; the deb and rpm are updated by downloading again.
```

- [ ] **Step 7: Run everything for this task**

Run: `cd client && node --experimental-strip-types --test test/appUpdate.test.ts test/updateBar.test.ts test/desktopShell.test.ts test/desktopBundle.test.ts test/cssMinify.test.ts && npx tsc --noEmit && npm run -s lint`
Expected: all pass; no type or lint output.

- [ ] **Step 8: Commit**

```bash
git add client/package.json client/package-lock.json client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/src-tauri/src/lib.rs client/src-tauri/tauri.conf.json client/src-tauri/capabilities/default.json client/src/lib/appUpdate.ts client/src/lib/desktopShell.ts client/src/hooks/useAppUpdate.ts client/src/components/UpdateBar.tsx client/src/index.css client/src/App.tsx client/test/appUpdate.test.ts client/test/updateBar.test.ts client/test/fixtures/renderUpdateBar.tsx client/test/desktopShell.test.ts client/test/desktopBundle.test.ts .github/workflows/release.yml DEPLOY.md
git diff --cached --name-only | grep -i -e "updater.key" -e "password" && echo "STOP: a key file is staged" || echo "no key files staged"
git commit -m "feat(desktop): the app offers its own updates, signed with our key"
```

---

### Task 7: Test builds that cannot touch the installed app's keys

The vault keeps its master key in one keychain entry, `kikkacord` / `vault-master`, whatever the app's identifier. Any build run on a machine that has the real app would share that entry, and a reset or burn in the test build would lock the real app's saved keys for good. This task gives a test build its own entry.

**Files:**
- Modify: `client/src-tauri/src/vault.rs`

**Interfaces:**
- Produces: a compile-time override. Building with `OHIYO_KEYRING_SERVICE=<name>` in the environment makes the build use the keychain entry `<name>` / `vault-master`. Without it, nothing changes.

- [ ] **Step 1: Add the guard test**

In the `tests` module of `client/src-tauri/src/vault.rs`:

```rust
    #[test]
    fn a_normal_build_keeps_the_keychain_entry_installed_copies_use() {
        // Changing this name would lock everyone out of their saved keys. CI and release
        // builds never set OHIYO_KEYRING_SERVICE.
        if option_env!("OHIYO_KEYRING_SERVICE").is_none() {
            assert_eq!(KEYRING_SERVICE, "kikkacord");
        }
        assert!(!KEYRING_SERVICE.is_empty());
    }
```

Run: `cd client/src-tauri && cargo test --locked a_normal_build_keeps`
Expected: PASS. (This test guards the name; it passes before and after the change. The override itself is proven in Task 9, Step 3, by looking at the keychain.)

- [ ] **Step 2: Add the override**

Replace

```rust
const KEYRING_SERVICE: &str = "kikkacord";
```

with

```rust
/// The keychain entry that holds the vault's master key. Every installed copy uses
/// "kikkacord"; changing it would lock people out of their saved keys. A test build can
/// be given its own entry at compile time (OHIYO_KEYRING_SERVICE), so trying a build on
/// a machine that also has the real app cannot touch the real app's key.
const KEYRING_SERVICE: &str = match option_env!("OHIYO_KEYRING_SERVICE") {
    Some(service) => service,
    None => "kikkacord",
};
```

- [ ] **Step 3: Run the vault tests both ways**

```bash
cargo test --locked vault
OHIYO_KEYRING_SERVICE=ohiyo-gate cargo test --locked vault
```
Expected: both runs pass (the second compiles the override in and still passes every vault test).

- [ ] **Step 4: Commit**

```bash
git add client/src-tauri/src/vault.rs
git commit -m "feat(desktop): a test build can use its own keychain entry"
```

---

### Task 8: Version 0.3.0, the changelog, and the pull request

**Files:**
- Modify: `client/package.json`, `client/package-lock.json`, `client/src-tauri/Cargo.toml`, `client/src-tauri/Cargo.lock`, `client/src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-04-desktop-release-design.md`
- Test: `client/test/desktopBundle.test.ts`

- [ ] **Step 1: Add the version test**

Append to `client/test/desktopBundle.test.ts`:

```ts
test("the app, the crate and the bundle agree on the version, and the changelog has that release", () => {
  const pkg = JSON.parse(readFileSync(join(tauri, "..", "package.json"), "utf8"));
  const crate = /^version = "([^"]+)"/m.exec(read("Cargo.toml"))?.[1];
  assert.equal(pkg.version, conf.version);
  assert.equal(crate, conf.version);
  const changelog = readFileSync(join(tauri, "..", "..", "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## [${conf.version}] — `), `CHANGELOG.md has a section for ${conf.version}`);
  assert.ok(changelog.includes(`[${conf.version}]: https://github.com/New1Direction/ohiyo/compare/`), "and its compare link");
});
```

Run: `cd client && node --experimental-strip-types --test test/desktopBundle.test.ts` — expected: PASS at 0.2.0 (it is a guard).

- [ ] **Step 2: Bump the three versions and see the test fail**

```bash
cd ~/Documents/Projects/oHiYo/client
npm version 0.3.0 --no-git-tag-version
sed -i '' 's/^version = "0.2.0"$/version = "0.3.0"/' src-tauri/Cargo.toml
sed -i '' 's/^  "version": "0.2.0",$/  "version": "0.3.0",/' src-tauri/tauri.conf.json
(cd src-tauri && cargo check --all-targets)     # updates the crate's own entry in Cargo.lock
git diff --stat                                  # package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json
node --experimental-strip-types --test test/desktopBundle.test.ts
```
Expected: the version test FAILS (`CHANGELOG.md has a section for 0.3.0`).

- [ ] **Step 3: Cut the changelog**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add as the first entry:

```markdown
- **Desktop app for Mac and Linux:** it stays in the tray when you close the window, so
  notifications keep arriving, with the unread count on the dock icon and a tray menu
  (open, leave call, check for updates, open at login, quit). It offers its own updates
  and installs one when you say so. On Mac it asks for the microphone and camera properly,
  so voice can work. It talks to the current server; 0.2.0 still pointed at the old one
  and has to be replaced by hand once. Mac builds are a beta that Apple has not verified.
  Windows is not included yet.
```

and under `### Fixed`, as the first entry:

```markdown
- **Settings said no notification ever shows message text.** That is true of push
  notifications only. Notifications while Ohiyo is running show who wrote and the start
  of the message, except in encrypted chats. The page now says so.
```

Then replace the line `## [Unreleased]` with (using the day's date from `date +%F`):

```markdown
## [Unreleased]

## [0.3.0] — 2026-10-04
```

and at the bottom replace

```markdown
[Unreleased]: https://github.com/New1Direction/ohiyo/compare/v0.2.0...HEAD
```

with

```markdown
[Unreleased]: https://github.com/New1Direction/ohiyo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/New1Direction/ohiyo/compare/v0.2.0...v0.3.0
```

Run: `node --experimental-strip-types --test test/desktopBundle.test.ts` — expected: all pass.

- [ ] **Step 4: Bring the spec in line with the rulings**

In `docs/superpowers/specs/2026-10-04-desktop-release-design.md`:

- §4, replace "**Coming back:** a click on the tray icon, on the Mac dock icon, on a notification, or a second launch shows and focuses the window." with "**Coming back:** the tray menu's Open Ohiyo, a click on the Mac dock icon or on a notification, or a second launch shows and focuses the window. A click on the tray icon opens its menu, as menu bar icons do."
- §5, replace "the app checks for `getUserMedia` and `RTCPeerConnection`. If either is missing," with "the app checks for `RTCPeerConnection` (a missing microphone is not a blocker: Ohiyo joins listen-only). If it is missing,".
- §8, replace the `capabilities/default.json` line's description "window show/hide/focus/badge, autostart, updater" with "updater (everything else goes through our own commands)".
- §9, in step 6 replace "one that checks they point at the published version" with "one that checks every link names a published version tag".
- §11, add as a last paragraph: "The gate runs before the tag is pushed, on local builds that use their own identifier and keychain entry, because the machine it runs on has the real app installed."

- [ ] **Step 5: Full check, commit, pull request**

```bash
cd ~/Documents/Projects/oHiYo/client
npx tsc --noEmit && npm run -s lint && npm run -s test:unit
(cd src-tauri && cargo test --locked)
cd .. && git add client/package.json client/package-lock.json client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock client/src-tauri/tauri.conf.json client/test/desktopBundle.test.ts CHANGELOG.md docs/superpowers
git status --short          # only ohiyo-launch-checklist.html (the owner's) is left untracked
git commit -m "chore(desktop): version 0.3.0 and its changelog"
git push -u origin feat/desktop-release
gh pr create --repo New1Direction/ohiyo --base main --head feat/desktop-release --title "Desktop 0.3.0: tray, voice on Mac, self-updates" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-10-04-desktop-release-design.md.

- Tray icon with a menu; closing the window hides Ohiyo (on by default on Mac, off on Linux); unread count on the dock icon; open at login.
- Mac microphone and camera permissions, so voice can work in the desktop app. A shell that cannot call says so.
- The app offers its own updates, signed with a key held in the repo's secrets. Only the release workflow makes update bundles; a plain local build needs no key.
- Settings gains a "Desktop app" card, and no longer says every notification hides message text.
- A test build can be given its own keychain entry, so it cannot touch an installed copy's keys.
- Version 0.3.0.

Not in this change: Windows, Apple signing, a call relay. The Linux build is produced by CI and has not been run by hand.

Nothing is published by merging this. The tag is pushed only after the hands-on checks, and the release stays a draft until the owner says publish.
EOF
```

Wait for all 7 checks to pass on the pushed commit, then `gh pr merge <number> --repo New1Direction/ohiyo --merge`. A merge with a failing check is not allowed; fix the cause on the branch instead.

---

### Task 9: The hands-on session and the update gate (isolated local builds)

Runs on `main` after the merge, before any tag. Two builds are made, version 0.3.0 ("A") and 0.3.1 ("B"), both named **OhiyoGate** with identifier `app.ohiyo.desktop.gate`, link scheme `ohiyo-gate`, keychain entry `ohiyo-gate`, the local server, and a local update feed. They share nothing with the installed Ohiyo.

No product files change in this task unless a check fails.

- [ ] **Step 1: Record the installed app's state, so it can be shown untouched afterwards**

```bash
GATE="$SCRATCH/gate" && mkdir -p "$GATE/feed" "$GATE/Applications"
# Attributes only. Never -w or -g, which would read the secret and prompt.
security find-generic-password -s kikkacord -a vault-master 2>/dev/null | grep -E '"(mdat|cdat)"' > "$GATE/real-key.before"
ls -lT "$HOME/Library/Application Support/app.ohiyo.desktop" > "$GATE/real-data.before"
cat "$GATE/real-key.before"
```

- [ ] **Step 2: Prove a plain build needs no key, then build A and B**

`$GATE/make_config.py`:

```python
"""Writes the config override for a gate build: its own name, identifier and link scheme,
the local server and a local update feed, so it cannot touch the installed Ohiyo."""
import json
import sys
from pathlib import Path

SERVER = "http://localhost:3000"
FEED = "http://127.0.0.1:8765/latest.json"
# Where the real policy allows https, the gate build also needs the local server.
LOCAL_SOURCES = {"connect-src": f"{SERVER} ws://localhost:3000", "img-src": SERVER, "media-src": SERVER}


def local_csp(csp: str) -> str:
    """The app's own content policy with the local server added."""
    directives = []
    for directive in csp.split("; "):
        name = directive.split(" ", 1)[0]
        directives.append(f"{directive} {LOCAL_SOURCES[name]}" if name in LOCAL_SOURCES else directive)
    return "; ".join(directives)


def main() -> None:
    conf_path, version, out_path = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    conf = json.loads(conf_path.read_text())
    override = {
        "productName": "OhiyoGate",
        "version": version,
        "identifier": "app.ohiyo.desktop.gate",
        "app": {"security": {"csp": local_csp(conf["app"]["security"]["csp"])}},
        "bundle": {"createUpdaterArtifacts": True},
        "plugins": {
            "deep-link": {"desktop": {"schemes": ["ohiyo-gate"]}},
            "updater": {"endpoints": [FEED], "dangerousInsecureTransportProtocol": True},
        },
    }
    out_path.write_text(json.dumps(override, indent=2) + "\n")


if __name__ == "__main__":
    main()
```

Each build takes several minutes; run them in the background and wait for the result. All exports must be in the same command as the build.

```bash
cd ~/Documents/Projects/oHiYo/client
export CARGO_TARGET_DIR="$SCRATCH/desktop-target" CARGO_INCREMENTAL=0
rm -rf "$CARGO_TARGET_DIR/debug" && df -h / | tail -1          # at least 4 GB free

# 1. The command the README gives, with no key: it must work and make no update bundle.
env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD npm run tauri build -- --bundles app
ls "$CARGO_TARGET_DIR/release/bundle/macos"                     # Ohiyo.app only, no .tar.gz
rm -rf "$CARGO_TARGET_DIR/release/bundle"                       # never launched: it has the real identifier

# 2. Gate builds.
export OHIYO_KEYRING_SERVICE=ohiyo-gate
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/Desktop/ohiyo-update-key/ohiyo-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/Desktop/ohiyo-update-key/password.txt")"
build_gate() {   # $1 = version
  python3 "$GATE/make_config.py" src-tauri/tauri.conf.json "$1" "$GATE/conf-$1.json"
  VITE_SERVER_URL=http://localhost:3000 npm run tauri build -- --bundles app --config "$GATE/conf-$1.json"
}
build_gate 0.3.0 && cp -R "$CARGO_TARGET_DIR/release/bundle/macos/OhiyoGate.app" "$GATE/Applications/OhiyoGate.app"
build_gate 0.3.1 && cp "$CARGO_TARGET_DIR/release/bundle/macos/OhiyoGate.app.tar.gz" "$CARGO_TARGET_DIR/release/bundle/macos/OhiyoGate.app.tar.gz.sig" "$GATE/feed/"
```

If step 1 fails asking for a private key, stop: ruling 4 is wrong and the plan needs a different way to keep local builds working. Report it; do not guess.

Write the feed (not yet served):

```bash
python3 - "$GATE/feed" <<'EOF'
import datetime
import json
import platform
import sys
from pathlib import Path

feed = Path(sys.argv[1])
arch = "aarch64" if platform.machine() == "arm64" else "x86_64"
manifest = {
    "version": "0.3.1",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        f"darwin-{arch}": {
            "signature": (feed / "OhiyoGate.app.tar.gz.sig").read_text(),
            "url": "http://127.0.0.1:8765/OhiyoGate.app.tar.gz",
        }
    },
}
(feed / "latest.json").write_text(json.dumps(manifest))
EOF
```

- [ ] **Step 3: Check build A from the outside, before anyone opens it**

```bash
APP="$GATE/Applications/OhiyoGate.app"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" -c "Print :CFBundleShortVersionString" -c "Print :NSMicrophoneUsageDescription" "$APP/Contents/Info.plist"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -c "device.audio-input"      # 1
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$APP/Contents/Info.plist"   # ohiyo-gate
```
Expected: `app.ohiyo.desktop.gate`, `0.3.0`, the microphone sentence, the entitlement, the scheme `ohiyo-gate`. If the identifier or scheme is the real one, stop and fix the override before launching anything.

Start the local stack (Global Constraints). In a Playwright browser at `http://localhost:1420`, register an account `friend`, create a space "Gate" with a voice room, and copy an invite link. Then `open "$APP"`.

After the owner has signed up in the app (Step 4, line 1), confirm the isolation held:

```bash
security find-generic-password -s ohiyo-gate -a vault-master >/dev/null 2>&1 && echo "gate key: its own entry"
ls "$HOME/Library/Application Support/app.ohiyo.desktop.gate"                          # kc-vault.bin, desktop-prefs.json
security find-generic-password -s kikkacord -a vault-master 2>/dev/null | grep -E '"(mdat|cdat)"' | diff - "$GATE/real-key.before" && echo "real key: untouched"
```

- [ ] **Step 4: The owner's session (about 15 minutes)**

The owner does the left column in the OhiyoGate window; Claude does the middle column and writes down what happened for every line.

| # | The owner | Claude | Expected |
|---|---|---|---|
| 1 | Create an account `desk` in OhiyoGate. Allow notifications if macOS asks. | Runs the isolation check from Step 3. | Signed in on the local server. |
| 2 | Join the space with the invite link Claude gives (paste it into "Join a space"). | | The space "Gate" appears. |
| 3 | Close the window with the red button. | `pgrep -f "OhiyoGate.app/Contents/MacOS"` | The process is still there. A notification: "Ohiyo is still running in the menu bar." A menu bar icon. |
| 4 | Do nothing. | Sends a message as `friend` in the channel that was open. | A notification with `friend`'s name. A "1" on the Dock icon. |
| 5 | Click that notification. | | The window comes back; the Dock number clears; `friend`'s browser shows the message as read. |
| 6 | Close the window; click the Dock icon. Close it again; switch to OhiyoGate with Cmd+Tab. | | The window comes back both times. |
| 7 | Click the menu bar icon. | | Open Ohiyo · Check for updates · Open at login · Quit Ohiyo. |
| 8 | Settings → Notifications → Desktop app: turn on "Open Ohiyo when I log in", then off. | `ls ~/Library/LaunchAgents/OhiyoGate.plist` after each. | The file exists after on, is gone after off. The menu bar tick follows. |
| 9 | Join the voice room. Allow the microphone when macOS asks. In your own browser open the invite link, make a third account, join the same room. | | macOS shows the microphone sentence from Task 1. Sound goes both ways (expect echo: both ends are on one machine). |
| 10 | Menu bar icon → Leave call. | | "Leave call" is in the menu during the call; choosing it ends the call; the item is gone afterwards. |
| 11 | In a DM with `friend`, turn the lock on and send "before". | Replies as `friend`. | Both messages readable on both sides. |
| 12 | Close the window and leave it for five minutes. | Sends one message at the end. | The notification arrives within a few seconds. |
| 13 | Menu bar icon → Check for updates (the feed is not running yet). | | A message: "Couldn't check for updates. Try again later." |
| 14 | Menu bar icon → Check for updates again. | First: `(cd "$GATE/feed" && python3 -m http.server 8765 --bind 127.0.0.1)` in the background. | A bar: "Ohiyo 0.3.1 is ready". |
| 15 | Press Later, then Check for updates again, then **Update now**. | | Later hides the bar; the check brings it back; Update now shows "Updating… Ohiyo will restart." and the app restarts. |
| 16 | Say exactly what you see after the restart, including any prompt from macOS. Open the DM; send "after". | `PlistBuddy … CFBundleShortVersionString` on the app. | See Step 5. |
| 17 | Menu bar icon → Quit Ohiyo. | `pgrep …` | The process is gone. |

If line 12 fails (late or missing notification): add `<key>NSAppSleepDisabled</key><true/>` to `client/src-tauri/Info.plist`, rebuild A, repeat line 12, and ship that change through a pull request before tagging.

If line 5 or 6 fails to bring the window back: write down which, fix `hide_main`/`show_main` in a pull request, rebuild and repeat.

- [ ] **Step 5: The gate's verdict**

- **Pass:** after the update the app is version 0.3.1, opens signed in, the encrypted DM ("before") is readable, and "after" is delivered. macOS may ask once for the login keychain password; with Always Allow the app continues. Write down whether it asked, and whether it asked for the microphone again.
- **Fail:** the locked-vault screen appears and "Try again" does not open it, or "before" cannot be read.

**If it fails:** in a pull request, make `checkForUpdate()` return `null` on a Mac (`navigator.userAgent.includes("Mac")`), with a test in `desktopShell.test.ts`, remove "Check for updates" from the tray menu on macOS, and say in the changelog that Mac users update by downloading until the app is signed. Merge it before tagging. Tell the owner plainly.

**If it passes with a keychain prompt,** Task 11's release notes and download page say: "After an update, macOS may ask for your keychain password once. Choose Always Allow."

- [ ] **Step 6: Clean up, and show the installed app was not touched**

```bash
pkill -f "OhiyoGate.app/Contents/MacOS"; kill $(lsof -nP -tiTCP:8765 -sTCP:LISTEN) 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/OhiyoGate.plist"
security delete-generic-password -s ohiyo-gate -a vault-master >/dev/null 2>&1
tccutil reset Microphone app.ohiyo.desktop.gate; tccutil reset Camera app.ohiyo.desktop.gate
rm -rf "$HOME/Library/Application Support/app.ohiyo.desktop.gate" "$HOME/Library/Caches/app.ohiyo.desktop.gate" "$HOME/Library/WebKit/app.ohiyo.desktop.gate"
security find-generic-password -s kikkacord -a vault-master 2>/dev/null | grep -E '"(mdat|cdat)"' | diff - "$GATE/real-key.before" && echo "real key: untouched"
ls -lT "$HOME/Library/Application Support/app.ohiyo.desktop" | diff - "$GATE/real-data.before" && echo "real data: untouched"
```
Stop the local stack. Remove `$GATE`, `$SCRATCH/stack` and `$CARGO_TARGET_DIR/release`. Expected: both "untouched" lines print.

---

### Task 10: The tag and the draft release

- [ ] **Step 1: Point release builds at the live server, then tag**

`client/.env.production` already names the Railway server; the `VITE_SERVER_URL` secret overrides it and still holds the old Fly address.

```bash
gh secret set VITE_SERVER_URL --repo New1Direction/ohiyo --body "https://ohiyo-server-production.up.railway.app"
gh secret list --repo New1Direction/ohiyo      # VITE_SERVER_URL updated today; the two TAURI_SIGNING names present
cd ~/Documents/Projects/oHiYo && git checkout main && git pull --ff-only origin main
git tag v0.3.0 && git push origin v0.3.0
```

Watch the Release workflow run (about 15 minutes; check on it rather than holding a command open). If a job fails, read its log, fix the cause through a pull request, delete the tag and the draft (`gh release delete v0.3.0 --yes --cleanup-tag`), and tag again. Nothing is public at this point.

- [ ] **Step 2: Check what the draft holds**

```bash
gh release view v0.3.0 --repo New1Direction/ohiyo --json isDraft,assets -q '"draft=\(.isDraft)\n" + ([.assets[].name] | sort | join("\n"))'
mkdir -p "$SCRATCH/release" && cd "$SCRATCH/release"
gh release download v0.3.0 --repo New1Direction/ohiyo --pattern "latest.json" --pattern "Ohiyo_0.3.0_aarch64.dmg"
python3 -c "import json; m = json.load(open('latest.json')); print(m['version'], sorted(m['platforms']))"
mkdir mnt && hdiutil attach Ohiyo_0.3.0_aarch64.dmg -nobrowse -quiet -mountpoint "$PWD/mnt"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" -c "Print :CFBundleShortVersionString" -c "Print :NSMicrophoneUsageDescription" mnt/Ohiyo.app/Contents/Info.plist
codesign -d --entitlements - mnt/Ohiyo.app 2>/dev/null | grep -c "device.audio-input"
hdiutil detach "$PWD/mnt" -quiet
```
Expected: `draft=true`; two DMGs, an AppImage, a deb, an rpm, update bundles with `.sig` files for both Mac builds and the AppImage, and `latest.json`; the manifest says `0.3.0` with `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64`; the app is `app.ohiyo.desktop`, `0.3.0`, with the microphone sentence and entitlement. **Do not launch this app**: it has the real identifier, and its first launch belongs to the owner.

If `latest.json` or the `.sig` files are missing, the "Turn on signed update bundles" step did not take effect: read the run's log for that step, fix, delete the tag and draft, and tag again.

- [ ] **Step 3: Report to the owner and stop**

Tell the owner, in plain words: what passed in Task 9, what the gate's verdict was, that the Linux build is untested, that the draft is ready, and how to try it as its first real user (download the DMG from the draft, replace their 0.2.0, sign in to the live server with their own account). The built-in server address can only be confirmed by that first launch. Do not publish.

---

### Task 11: Publish, then the download page (only after the owner says publish)

**Files:**
- Modify: `site/index.html`, `site/site.css`, `client/test/siteLanding.test.ts`
- Modify: `README.md`, `LAUNCH-STATUS.md`, `GO-LIVE.md`, `CHANGELOG.md`

- [ ] **Step 1: Publish the release**

Leave out the voice line if the owner's call in Task 9 did not have sound both ways, and the keychain sentence if the gate showed no prompt.

```bash
gh release edit v0.3.0 --repo New1Direction/ohiyo --draft=false --latest --notes-file - <<'EOF'
Ohiyo for Mac and Linux.

- Stays in the tray when you close the window, so notifications keep arriving.
- Unread count on the dock icon.
- Voice works in the Mac app.
- Offers its own updates from now on. After an update, macOS may ask for your keychain password once. Choose Always Allow.

**The Mac build is a beta that Apple has not verified.** The first time, macOS will refuse to open it. Open System Settings → Privacy & Security, scroll down, and press Open Anyway.

**Coming from 0.2.0?** Download this version once. It talks to the current server, and later versions arrive by themselves.

The Linux build has not been run by hand, and voice may not work in it. Windows is not available yet.
EOF
curl -fsSL https://github.com/New1Direction/ohiyo/releases/latest/download/latest.json | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])"   # 0.3.0
gh release view v0.3.0 --repo New1Direction/ohiyo --json assets -q '.assets[].name' | sort
```

Use the asset names that last command prints in Step 3.

- [ ] **Step 2: Replace the test that forbids download links**

In `client/test/siteLanding.test.ts`, replace

```ts
    // The hosted server moved off Fly, and the released desktop builds still point at the old one.
    assert.equal(/fly\.dev/.test(html), false, `${page} does not name the old server`);
    assert.equal(/releases\/(latest\/)?download/.test(html), false, `${page} does not offer the outdated desktop builds`);
```

with

```ts
    // The hosted server moved off Fly.
    assert.equal(/fly\.dev/.test(html), false, `${page} does not name the old server`);
    // Installer names contain the version, so a "latest" link breaks when the next version is
    // published. Every download names one published version; an older installer updates itself.
    assert.equal(/releases\/latest\/download/.test(html), false, `${page} links no "latest" installer`);
    for (const [, tag, file] of html.matchAll(/releases\/download\/([^/"]+)\/([^"]+)"/g)) {
      assert.match(tag, /^v\d+\.\d+\.\d+$/, `${page} links a version tag`);
      assert.ok(file.includes(tag.slice(1)), `${page}: ${file} belongs to ${tag}`);
    }
```

and add:

```ts
test("the download section says the Mac build is an unverified beta, and how to open it", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  assert.match(html, /<section[^>]*id="download"/);
  assert.match(html, /Apple has not verified/);
  assert.match(html, /Open Anyway/);
  assert.ok((html.match(/releases\/download\/v/g) ?? []).length >= 5, "two Mac builds and three Linux packages");
});
```

Run: `cd client && node --experimental-strip-types --test test/siteLanding.test.ts` — expected: the new test FAILS.

- [ ] **Step 3: Add the Download section**

In `site/index.html`, directly before `<section class="band band--paper" id="own">`, add (it reuses the page's own `duo` and `card` pieces):

```html
<section class="band band--deep" id="download">
  <svg class="wave" viewBox="0 0 1440 80" preserveAspectRatio="none" aria-hidden="true"><path d="M0 58C190 14 360 6 560 32s340 52 540 26 250-40 340-28v50H0Z"/></svg>
  <div class="wrap">
    <div class="head reveal">
      <h2>Keep it in your dock.</h2>
      <p class="lead">The desktop app stays in the tray, tells you when a friend writes, and updates itself. Everything else is the same as in your browser.</p>
    </div>
    <div class="duo duo--flush">
      <article class="card card--night reveal">
        <h3>Mac</h3>
        <p>A beta that Apple has not verified. The first time, macOS will refuse to open it: go to System Settings → Privacy &amp; Security, scroll down, and press <b>Open Anyway</b>.</p>
        <div class="card__actions">
          <a class="btn btn--go" href="https://github.com/New1Direction/ohiyo/releases/download/v0.3.0/Ohiyo_0.3.0_aarch64.dmg" rel="noopener">Apple Silicon</a>
          <a class="btn" href="https://github.com/New1Direction/ohiyo/releases/download/v0.3.0/Ohiyo_0.3.0_x64.dmg" rel="noopener">Intel</a>
        </div>
      </article>
      <article class="card card--sand reveal">
        <h3>Linux</h3>
        <p>Built automatically and not yet tried by hand. Only the AppImage updates itself. Voice may not work in the Linux app; it does in the browser.</p>
        <div class="card__actions">
          <a class="btn btn--go" href="https://github.com/New1Direction/ohiyo/releases/download/v0.3.0/Ohiyo_0.3.0_amd64.AppImage" rel="noopener">AppImage</a>
          <a class="btn" href="https://github.com/New1Direction/ohiyo/releases/download/v0.3.0/Ohiyo_0.3.0_amd64.deb" rel="noopener">.deb</a>
          <a class="btn" href="https://github.com/New1Direction/ohiyo/releases/download/v0.3.0/Ohiyo-0.3.0-1.x86_64.rpm" rel="noopener">.rpm</a>
        </div>
        <p>On Windows? Not yet. <a href="https://app.ohiyo.gg">Ohiyo in your browser</a> works there today.</p>
      </article>
    </div>
  </div>
</section>
```

Correct any file name that differs from what Step 1 printed. In the nav, after `<a href="#inside">What's inside</a>`, add `<a href="#download">Download</a>`.

In `site/site.css`, directly after the `.duo { … }` rule:

```css
.duo--flush { margin-top: 0; }
```

Then:

```bash
python3 scripts/site-version.py
cd client && node --experimental-strip-types --test test/siteLanding.test.ts
```
Expected: all site tests pass.

- [ ] **Step 4: Look at it**

Serve `site/` locally and screenshot the section and the nav at 320, 375, 768, 1024, 1440 and 1920 wide. Check: no horizontal scroll; the nav's six links fit or collapse as the five did; buttons wrap cleanly; the link inside the Linux card is readable on its background (contrast at least 4.5:1); with reduced motion the section is simply there. Fix what is off before going on.

- [ ] **Step 5: Bring the status documents in line**

- `README.md`, the status note: replace "v0.2.0 public beta" with "v0.3.0 public beta", and "Desktop builds are in [Releases](../../releases); Mac builds are beta/ad-hoc signed until Apple notarization is complete." with "Desktop apps for Mac and Linux are on [ohiyo.gg](https://ohiyo.gg/#download) and in [Releases](../../releases); the Mac build is a beta that Apple has not verified yet."
- `LAUNCH-STATUS.md`: replace "Desktop builds released before this point still talk to `ohiyo.fly.dev` and need a new release." with "Desktop 0.3.0 talks to the Railway server and updates itself. 0.2.0 and older still talk to `ohiyo.fly.dev` and have to be replaced by hand once."; replace "Public macOS desktop downloads are paused until Developer ID signing/notarization is configured." with "macOS desktop downloads are public as an ad-hoc-signed beta; Developer ID signing/notarization is still to do."
- `GO-LIVE.md`: replace the "Desktop public release" row's status with "⚠️ 0.3.0 is public for Mac (beta, not Apple verified) and Linux (untested by hand); Windows not yet".
- `CHANGELOG.md`, under `## [Unreleased]` add `### Added` with: "- **ohiyo.gg has a Download section** for the desktop app, with the steps to open the Mac beta."

- [ ] **Step 6: Ship it and check the live site**

Commit on a branch `site/download`, open a pull request, wait for all 7 checks, merge. The site deploys itself from `main`. Then:

```bash
curl -fsSL https://ohiyo.gg/ | grep -c 'id="download"'            # 1 (allow ten minutes for the cache)
curl -fsSL https://ohiyo.gg/ | grep -o 'https://github.com/New1Direction/ohiyo/releases/download/[^"]*' | sort -u | while read -r url; do
  curl -s -o /dev/null -w "%{http_code} $url\n" -I "$url"
done
```
Expected: every link answers `302`. Tell the owner the key folder on the Desktop can now be moved into a password manager and deleted.
