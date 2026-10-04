// Field length limits the server now enforces (it answers 400 with a message such as
// "bio is too long (max 500 characters)"). The profile inputs carry matching maxLength,
// and a failed save shows the server's message instead of a generic one.
//   node --experimental-strip-types --test test/fieldLimits.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { errorMessage } from "../src/lib/errorMessage.ts";
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

function profileTab(): string {
  return bundle.mod.renderSettingsModal({
    currentUser: null,
    pluginManager: {},
    token: "t",
    servers: [],
    dms: [],
    initialTab: "profile",
    onClose() {},
    onToast() {},
    privacyPrefs: { metadataMode: false },
    onPrivacyPrefsChange() {},
  });
}

// The opening tag of the field whose placeholder is `placeholder`.
function field(html: string, placeholder: string): string {
  const at = html.indexOf(`placeholder="${placeholder}"`);
  assert.ok(at !== -1, `no field with placeholder ${placeholder}`);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

test("the profile's custom status and bio stop at the server's limits", () => {
  const html = profileTab();
  assert.match(field(html, "Building something cool..."), /maxLength="128"/i);
  assert.match(field(html, "Tell people about yourself..."), /maxLength="500"/i);
});

test("a failed save shows the server's message", () => {
  assert.equal(errorMessage(new Error("bio is too long (max 500 characters)"), "Failed to save"), "bio is too long (max 500 characters)");
});

test("with no message from the server, the fallback is shown", () => {
  for (const err of [new Error(""), new Error("   "), "boom", undefined]) assert.equal(errorMessage(err, "Failed to save"), "Failed to save");
});
