// C-H8: the locked-vault screen. Both kinds offer Try again (restarts the app). A keychain
// lock explains how to unlock the keychain and offers no reset, since a reset can't help
// and would destroy keys that can still be recovered. Saved keys that can't be opened
// offer Reset this device, behind a confirmation that says plainly what a reset costs.
//   node --experimental-strip-types --test test/vaultLockedScreen.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Props = Record<string, unknown>;
type Mod = { renderLockedScreen: (props: Props) => string; renderResetConfirm: (props: Props) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderVaultLockedScreen.tsx"));
});

after(async () => {
  await bundle?.cleanup();
});

const actions = { onTryAgain: async () => {}, onReset: async () => {} };
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());

test("a keychain lock explains how to unlock it, offers Try again and no reset", () => {
  const html = bundle.mod.renderLockedScreen({ locked: { kind: "keychain", reason: "the OS keychain could not be read: denied" }, ...actions });
  assert.match(
    text(html),
    /Ohiyo keeps your encryption keys in the system keychain\. Unlock it \(on Linux, start a Secret Service provider such as GNOME Keyring or KWallet\), then try again\. Nothing was deleted\./,
  );
  assert.deepEqual(buttons(html), ["Try again"]);
});

test("saved keys that can't be opened offer Try again and Reset this device", () => {
  const html = bundle.mod.renderLockedScreen({ locked: { kind: "vault", reason: "the sealed vault could not be opened" }, ...actions });
  assert.match(text(html), /The encryption keys saved on this device can't be opened\./);
  assert.deepEqual(buttons(html), ["Try again", "Reset this device"]);
});

test("the reset confirmation says what a reset costs before anything happens", () => {
  const html = text(bundle.mod.renderResetConfirm({ busy: false, onConfirm() {}, onCancel() {} }));
  assert.match(html, /Encrypted messages stored on this device can no longer be read here\./);
  assert.match(html, /You'll be signed out\./);
  assert.match(html, /Your contacts will see a new safety number for you\./);
  assert.match(html, /This device will count as a new one of your 10 linked devices\. You can remove the old one in Settings → Privacy & security → Linked devices\./);
});
