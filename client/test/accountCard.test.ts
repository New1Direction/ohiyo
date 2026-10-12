// The Account card in Settings printed the raw user ID (a UUID) under your name. Nobody
// needs to read it; it stays one click away for support or self-hosting.
//   node --experimental-strip-types --test test/accountCard.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { renderSettingsModal: (props: Record<string, unknown>) => string };
let bundle: Bundle<Mod>;

before(async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const g = globalThis as Record<string, unknown>;
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

const USER_ID = "1f2e3d4c-5b6a-4789-8abc-def012345678";

function accountTab(): string {
  return bundle.mod.renderSettingsModal({
    currentUser: {
      id: USER_ID,
      username: "alice",
      display_name: "Alice",
      avatar_url: null,
      status: "online",
      custom_status: null,
    },
    pluginManager: {},
    token: "t",
    servers: [],
    dms: [],
    initialTab: "account",
    onClose() {},
    onToast() {},
    privacyPrefs: { metadataMode: false },
    onPrivacyPrefsChange() {},
  });
}

test("the account card shows who you are, not your user ID", () => {
  const html = accountTab();
  assert.match(html, /Alice/);
  assert.match(html, /@alice/);
  assert.equal(html.includes(USER_ID), false, "the raw user ID is not printed");
});

test("the user ID is one click away", () => {
  const html = accountTab();
  assert.match(html, /<button[^>]*>[^<]*Copy user ID/);
});

test("the picture button is in sentence case", () => {
  const html = accountTab();
  assert.equal(html.includes("Upload Avatar"), false);
  assert.match(html, /Upload a picture or GIF/);
});
