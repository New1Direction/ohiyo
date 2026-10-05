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

test("the app, the crate and the bundle agree on the version, and the changelog has that release", () => {
  const pkg = JSON.parse(readFileSync(join(tauri, "..", "package.json"), "utf8"));
  const crate = /^version = "([^"]+)"/m.exec(read("Cargo.toml"))?.[1];
  assert.equal(pkg.version, conf.version);
  assert.equal(crate, conf.version);
  const changelog = readFileSync(join(tauri, "..", "..", "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## [${conf.version}] — `), `CHANGELOG.md has a section for ${conf.version}`);
  assert.ok(changelog.includes(`[${conf.version}]: https://github.com/New1Direction/ohiyo/compare/`), "and its compare link");
});

test("Linux packages depend on the tray library that Debian and Ubuntu both ship", () => {
  // The bundler names the package dependency after whichever dev package is installed where
  // it builds. libappindicator3-1 is gone from Debian; the ayatana one is in both.
  for (const name of ["release.yml", "ci.yml"]) {
    const workflow = readFileSync(join(tauri, "..", "..", ".github", "workflows", name), "utf8");
    assert.match(workflow, /apt-get install[^\n]*libayatana-appindicator3-dev/, name);
    assert.doesNotMatch(workflow, /libappindicator3-dev/, name);
  }
});

test("release builds, and only they, look for updates", () => {
  // A copy someone builds by hand still carries our key and address. If it looked for
  // updates it would install the official build, which talks to the official server.
  const workflow = readFileSync(join(tauri, "..", "..", ".github", "workflows", "release.yml"), "utf8");
  const builds = workflow.split("uses: tauri-apps/tauri-action@").length - 1;
  assert.equal(workflow.split("VITE_DESKTOP_UPDATES: ${{ env.HAS_UPDATE_KEY == 'true' && '1' || '' }}").length - 1, builds);
});

test("the window is never shown empty: it starts hidden and appears once its page is there", () => {
  // A web view paints white until its page's first frame, and no setting changes that on a
  // Mac. So the window is created hidden and shown when the page has loaded. A timer shows
  // it anyway if the page never reports in: a missing window is worse than an empty one.
  assert.equal(conf.app.windows[0].visible, false);
  // Not a background colour: measured on a Mac, the first frame was still white with one,
  // and it turned the window's title bar white for good on top of the dark app.
  assert.equal(conf.app.windows[0].backgroundColor, undefined);
  const lib = readFileSync(join(tauri, "src", "lib.rs"), "utf8");
  assert.match(lib, /\.on_page_load\(/);
  assert.match(lib, /PageLoadEvent::Finished[\s\S]{0,160}tray::reveal_main\(/);
  const tray = readFileSync(join(tauri, "src", "tray.rs"), "utf8");
  assert.match(tray, /sleep\(REVEAL_FALLBACK\);\s*reveal_main\(/);
});

test("the page carries no inline style element", () => {
  // The desktop build adds a nonce to every <style> in this file and to the style policy.
  // A policy with a nonce ignores 'unsafe-inline', so the <style> elements the app creates
  // later (plugin CSS: Compact chat, Focus mode, anything third-party) would be blocked.
  const html = readFileSync(join(tauri, "..", "index.html"), "utf8");
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.match(conf.app.security.csp, /style-src 'self' 'unsafe-inline'/);
});

test("the one command that waits for the keychain runs off the main thread", () => {
  // The keychain can hold the answer back behind a password prompt. `vault_snapshot` waits
  // for it; a plain (non-async) command would do that waiting on the main thread, and the
  // window would freeze unpainted for as long as the prompt is up.
  const vault = readFileSync(join(tauri, "src", "vault.rs"), "utf8");
  assert.match(vault, /#\[tauri::command\(async\)\]\npub fn vault_snapshot\(/);
  // Start-up must not unlock inline either: nothing before the thread it starts may touch
  // the unlock.
  const init = vault.slice(vault.indexOf("pub fn init("), vault.indexOf("#[tauri::command]"));
  const [before, ...threads] = init.split("std::thread::spawn(");
  assert.equal(threads.length, 1);
  assert.doesNotMatch(before, /unlock/);
  assert.match(threads[0], /unlock_once\(unlock\)/);
});

test("no command that talks to the keychain runs on the main thread", () => {
  // Any keychain call can end up behind a password prompt. A plain command runs on the main
  // thread, where waiting for that prompt freezes the whole window.
  const vault = readFileSync(join(tauri, "src", "vault.rs"), "utf8");
  const commands = [...vault.matchAll(/#\[tauri::command(\(async\))?\]\n(?:pub )?fn (\w+)[\s\S]*?\n\}\n/g)];
  assert.ok(commands.length >= 7, `found ${commands.length} commands`);
  const onMainThread = commands.filter(([, isAsync]) => !isAsync);
  const offenders = onMainThread.filter(([body]) => /keyring::|unlock_once\(/.test(body)).map(([, , name]) => name);
  assert.deepEqual(offenders, []);
});
