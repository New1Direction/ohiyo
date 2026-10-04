// C1 / N2: signing out removes this device's decrypted-message cache, outbox and drafts.
// The cache is the only readable copy of past encrypted messages and is shared by every
// home on the device, so it is removed only when the last signed-in home signs out, and
// only after the user confirms. Signing out of one home while another stays signed in
// removes nothing. An expired session (BootSplash's "Back to sign in") removes nothing;
// instead, signing in as a different user than the one who last used the home here, with
// no other home signed in, removes the previous account's data first. Both decisions read
// the homes as stored right now, so a home signed in from another tab counts.
//   node --experimental-strip-types --test test/signOut.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { loadHomes, saveHomes, setHomeLastUser } from "../src/lib/homes.ts";
import {
  signInRemovesLocalData,
  signInRemovesLocalDataNow,
  signOutRemovesLocalData,
  signOutRemovesLocalDataNow,
} from "../src/lib/signOut.ts";
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

test("signing in as the same user keeps local data", () => {
  assert.equal(signInRemovesLocalData("u1", "u1", false), false);
});

test("signing in as a different user removes the previous account's data", () => {
  assert.equal(signInRemovesLocalData("u1", "u2", false), true);
});

test("a home with no remembered user keeps local data (nothing to protect yet, upgrades keep history)", () => {
  assert.equal(signInRemovesLocalData(null, "u2", false), false);
  assert.equal(signInRemovesLocalData(undefined, "u2", false), false);
});

test("another home still signed in keeps local data, whoever signs in", () => {
  assert.equal(signInRemovesLocalData("u1", "u2", true), false);
});

// The homes as another tab left them in storage: home a remembers user u1.
function storeHomes(tokens: Record<string, string>): void {
  const m = new Map<string, string>([
    [
      "kc:homes:v1",
      JSON.stringify([
        { id: "a", name: "A", url: "https://a.example", token: null, lastUserId: "u1" },
        { id: "b", name: "B", url: "https://b.example", token: null },
      ]),
    ],
    ...Object.entries(tokens).map(([id, t]): [string, string] => [`kc:tok:${id}`, t]),
  ]);
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test("sign-out decides from the stored homes: a home signed in from another tab counts", () => {
  storeHomes({ a: "t1", b: "t2" });
  assert.equal(signOutRemovesLocalDataNow("a"), false);
  storeHomes({ a: "t1" });
  assert.equal(signOutRemovesLocalDataNow("a"), true);
});

test("sign-in decides from the stored homes: the remembered user and the other homes", () => {
  storeHomes({});
  assert.equal(signInRemovesLocalDataNow("a", "u2"), true);
  assert.equal(signInRemovesLocalDataNow("a", "u1"), false);
  assert.equal(signInRemovesLocalDataNow("b", "u2"), false); // b remembers nobody
  storeHomes({ b: "t2" });
  assert.equal(signInRemovesLocalDataNow("a", "u2"), false); // b is still signed in
});

test("a home remembers its last user across save and load", () => {
  storeHomes({});
  saveHomes(setHomeLastUser(loadHomes(), "b", "u7"));
  assert.equal(loadHomes().find((h) => h.id === "b")?.lastUserId, "u7");
  assert.equal(loadHomes().find((h) => h.id === "a")?.lastUserId, "u1");
});
