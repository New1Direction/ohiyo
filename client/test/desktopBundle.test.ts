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
