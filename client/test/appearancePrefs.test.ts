// Tests for the merge-safe appearance prefs helpers (the part that must not
// clobber other keys in the shared user-prefs blob).
//   node --experimental-strip-types --test test/appearancePrefs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeAppearanceIntoPrefs, readAppearancePrefs } from "../src/lib/appearancePrefs.ts";

test("mergeAppearanceIntoPrefs preserves unrelated keys", () => {
  const prefs = { plugins: { foo: true }, notifications: "all" };
  const out = mergeAppearanceIntoPrefs(prefs, { accent: "#abcdef" });
  assert.deepEqual(out.plugins, { foo: true });
  assert.equal(out.notifications, "all");
  assert.deepEqual(out.appearance, { accent: "#abcdef" });
});

test("mergeAppearanceIntoPrefs overwrites a prior appearance only", () => {
  const prefs = { appearance: { accent: "#000000" }, other: 1 };
  const out = mergeAppearanceIntoPrefs(prefs, { accent: "#ffffff" });
  assert.deepEqual(out.appearance, { accent: "#ffffff" });
  assert.equal(out.other, 1);
});

test("mergeAppearanceIntoPrefs does not mutate the input", () => {
  const prefs = { other: 1 };
  mergeAppearanceIntoPrefs(prefs, { accent: "#123456" });
  assert.deepEqual(prefs, { other: 1 });
});

test("density and fontScale ride along in the appearance slice", () => {
  const out = mergeAppearanceIntoPrefs(
    { notifications: "all" },
    { accent: "#abcdef", density: "compact", fontScale: 1.125 },
  );
  assert.deepEqual(out.appearance, { accent: "#abcdef", density: "compact", fontScale: 1.125 });
  assert.equal(out.notifications, "all");
  const read = readAppearancePrefs(out as Record<string, unknown>);
  assert.equal(read?.density, "compact");
  assert.equal(read?.fontScale, 1.125);
});

test("readAppearancePrefs returns the slice or null", () => {
  assert.deepEqual(readAppearancePrefs({ appearance: { accent: "#abc123" } }), { accent: "#abc123" });
  assert.equal(readAppearancePrefs({}), null);
  assert.equal(readAppearancePrefs(null), null);
  assert.equal(readAppearancePrefs(undefined), null);
  assert.equal(readAppearancePrefs({ appearance: "nope" }), null);
});
