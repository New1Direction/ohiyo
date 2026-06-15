// Unit tests for the pure theme-construction helpers behind the visual editor.
//   node --experimental-strip-types --test test/themes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCustomTheme,
  makeThemeId,
  THEME_VAR_GROUPS,
  BUILTIN_THEMES,
  type ThemeVar,
} from "../src/themes/index.ts";

const sampleVars: ThemeVar = { ...BUILTIN_THEMES[0].vars };

test("createCustomTheme builds a You-authored theme with the given id", () => {
  const t = createCustomTheme("Sunset", sampleVars, "custom-x");
  assert.equal(t.id, "custom-x");
  assert.equal(t.name, "Sunset");
  assert.equal(t.author, "You");
  assert.deepEqual(t.vars, sampleVars);
});

test("createCustomTheme falls back to a default name when blank", () => {
  assert.equal(createCustomTheme("   ", sampleVars, "id1").name, "My Theme");
  assert.equal(createCustomTheme("", sampleVars, "id2").name, "My Theme");
});

test("createCustomTheme copies vars (no aliasing of the input)", () => {
  const input: ThemeVar = { ...sampleVars };
  const t = createCustomTheme("X", input, "id3");
  input["--accent"] = "#000000";
  assert.notEqual(t.vars["--accent"], "#000000");
});

test("makeThemeId is custom-prefixed and unique across calls", () => {
  const a = makeThemeId();
  const b = makeThemeId();
  assert.ok(a.startsWith("custom-"), `bad prefix: ${a}`);
  assert.notEqual(a, b);
});

test("THEME_VAR_GROUPS covers exactly the 12 ThemeVar keys, no dupes", () => {
  const groupedKeys = THEME_VAR_GROUPS.flatMap((g) => g.vars.map((v) => v.key));
  const themeKeys = Object.keys(BUILTIN_THEMES[0].vars);
  assert.equal(groupedKeys.length, themeKeys.length, "count mismatch");
  assert.deepEqual([...groupedKeys].sort(), [...themeKeys].sort());
});
