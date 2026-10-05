// The screen shown on desktop while the key vault unlocks. Usually a blink. When the
// operating system asks for a password before it hands over the key (macOS does, for a copy
// of the app it hasn't seen read that key), the screen stays up for as long as the person
// takes to answer, so it has to say what is going on. Before, the app sat frozen behind
// that prompt with an empty white window.
//   node --experimental-strip-types --test test/vaultUnlocking.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { renderUnlocking: (props: { waiting: boolean }) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderVaultUnlocking.tsx"));
});

after(async () => {
  await bundle?.cleanup();
});

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

test("at first it only says the keys are being unlocked", () => {
  const html = bundle.mod.renderUnlocking({ waiting: false });
  assert.match(html, /role="status"/);
  assert.match(text(html), /Unlocking your keys/);
  assert.doesNotMatch(text(html), /password/);
});

test("a wait that drags on explains the password prompt and how to stop it repeating", () => {
  const said = text(bundle.mod.renderUnlocking({ waiting: true }));
  assert.match(said, /Unlocking your keys/);
  assert.match(said, /Your computer may be asking for your password\./);
  assert.match(said, /That's Ohiyo opening the keys to your encrypted chats, which it keeps in the system keychain\./);
  assert.match(said, /If you see “Always Allow”, choose it and you won't be asked on every launch\./);
});

test("the app shows this screen while the vault unlocks, not a bare line of text", () => {
  const app = readFileSync(join(fixtures, "..", "..", "src", "App.tsx"), "utf8");
  assert.match(app, /if \(!vaultReady\) \{[^}]*return <VaultUnlocking \/>;/s);
});
