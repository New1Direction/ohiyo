// Wording the app must not go back to. Each phrase here was on screen and was either untrue
// or only made sense to the people who built Ohiyo.
//   node --experimental-strip-types --test test/appWording.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Comment lines are for developers, so only the code is checked.
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);
const files = sourceFiles(src).map((path) => ({
  path: path.slice(src.length + 1),
  text: readFileSync(path, "utf8").split("\n").filter((line) => !isComment(line)).join("\n"),
}));

function filesContaining(phrase: string): string[] {
  return files.filter((f) => f.text.includes(phrase)).map((f) => f.path);
}

const UNTRUE = [
  // A DM opened from a one-time link starts with the lock off.
  "one-to-one encrypted conversation",
  // There are no threads.
  "private thread",
  // Uploads have a size limit.
  "files of any size",
  // A recovery code restores keys; it does not sign you in.
  "get back in on a new device",
  "If you saved a recovery code you can",
  // A space is joined by invite, but its channels are not end-to-end encrypted.
  '"Private space"',
  // The row showed inside DMs and in spaces the person only joined.
  "Space created",
  // Plugins that are not ES modules, described as if they were.
  "ES module",
  // "Invite someone" copied a note with a link to the project. That is not an invite.
  "note about Ohiyo",
  "Copy invite note",
  "Come hang out:",
];

const INSIDER = [
  "first-user funnel",
  "Grandma mode",
  "sleeping Instant Servers",
  "VAPID key on the relay",
  "OHIYO_WEB_PUSH_PUBLIC_KEY",
  "bearer token",
  "not E2E",
  "no Nitro",
  "Unlike Discord",
  "sealed envelopes",
  "recovery manifest",
  "cloned ratchet state",
  "fake retry loop",
  "account prefs",
  "behavioral metadata",
  "Bypass channel overwrites",
  "outside-only room glow",
  "content-free PWA push",
  "standalone chrome",
];

test("nothing on screen claims something that is not true", () => {
  for (const phrase of UNTRUE) assert.deepEqual(filesContaining(phrase), [], phrase);
});

test("nothing on screen uses words only the builders would know", () => {
  for (const phrase of INSIDER) assert.deepEqual(filesContaining(phrase), [], phrase);
});

test("the mascot is a chinchilla, not a squirrel", () => {
  assert.deepEqual(filesContaining("🐿"), []);
});

test("it says Sign out everywhere, not Log out in one place", () => {
  assert.deepEqual(filesContaining('"Log out"'), []);
});
