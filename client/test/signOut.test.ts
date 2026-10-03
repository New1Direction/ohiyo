// C1: signing out removes this device's decrypted-message cache, outbox and drafts. The
// cache is the only readable copy of past encrypted messages and is shared by every home
// on the device, so it is removed only when the last signed-in home signs out, and only
// after the user confirms. Signing out of one home while another stays signed in removes
// nothing.
//   node --experimental-strip-types --test test/signOut.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { signOutRemovesLocalData } from "../src/lib/signOut.ts";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { renderSignOutDialog: (props: Record<string, unknown>) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderSignOutDialog.tsx"), [
    // The real ModalShell portals into document.body, which the server renderer can't do.
    { find: /^\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

const home = (id: string, token: string | null) => ({ id, name: id, url: `https://${id}.example`, token });

test("signing out of the only signed-in home removes local data", () => {
  assert.equal(signOutRemovesLocalData([home("a", "t1")], "a"), true);
  assert.equal(signOutRemovesLocalData([home("a", "t1"), home("b", null)], "a"), true);
});

test("signing out while another home stays signed in removes nothing", () => {
  const homes = [home("a", "t1"), home("b", "t2")];
  assert.equal(signOutRemovesLocalData(homes, "a"), false);
  assert.equal(signOutRemovesLocalData(homes, "b"), false);
});

test("a home that isn't signed in has nothing to sign out of", () => {
  assert.equal(signOutRemovesLocalData([home("a", null)], "a"), false);
});

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());

test("the confirmation says what signing out removes, with Cancel and Sign out", () => {
  const html = bundle.mod.renderSignOutDialog({ onCancel() {}, onConfirm() {} });
  assert.equal(
    text(html),
    "Sign out? Encrypted messages you have read on this device, unsent messages and drafts will be removed from it. Those encrypted messages can't be decrypted here again. Your other devices are not affected. Cancel Sign out",
  );
  assert.deepEqual(buttons(html), ["Cancel", "Sign out"]);
});
