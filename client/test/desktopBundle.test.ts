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
