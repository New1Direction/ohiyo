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
    // Some Linux desktops show no tray: the card says how to get the window back regardless.
    assert.match(html, /Opening Ohiyo again brings the window back/);
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
  // "Closed" would be ambiguous: closing the desktop window keeps Ohiyo running.
  assert.match(html, /Push notifications, which reach you when Ohiyo isn(&#x27;|')t running, never include/);
  assert.match(html, /show who wrote and the start of the message, except in encrypted chats/);
});
