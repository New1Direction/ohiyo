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

test("THEME_VAR_GROUPS covers exactly the ThemeVar keys, no dupes", () => {
  const groupedKeys = THEME_VAR_GROUPS.flatMap((g) => g.vars.map((v) => v.key));
  const themeKeys = Object.keys(BUILTIN_THEMES[0].vars);
  assert.equal(groupedKeys.length, themeKeys.length, "count mismatch");
  assert.deepEqual([...groupedKeys].sort(), [...themeKeys].sort());
});

// --warning was used (an older recovery backup, a server waking up) but no theme defined
// it, so those notes fell back to plain text colour. Every built-in theme sets it now,
// readable on its own backgrounds.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("every built-in theme sets a warning colour readable on its backgrounds", () => {
  for (const theme of BUILTIN_THEMES) {
    const warning = theme.vars["--warning"];
    assert.match(warning ?? "", /^#[0-9a-f]{6}$/i, `${theme.id} has no --warning`);
    for (const bg of ["--bg-base", "--bg-sidebar", "--bg-channel"] as const) {
      const ratio = contrast(warning, theme.vars[bg]);
      assert.ok(ratio >= 4.5, `${theme.id}: --warning on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});

// Destructive buttons (Delete account, Remove and sign out, Sign out everywhere) were
// white text on --danger: 2.65-4.06:1, under the 4.5:1 that small text needs, in every
// built-in theme. They fill with --danger-fill now, a deeper red. And red text itself
// (errors, "Delete account" headings) fell short on five themes' backgrounds.
test("white on a danger fill is readable in every built-in theme", () => {
  for (const theme of BUILTIN_THEMES) {
    const fill = theme.vars["--danger-fill"];
    assert.match(fill ?? "", /^#[0-9a-f]{6}$/i, `${theme.id} has no --danger-fill`);
    const ratio = contrast("#ffffff", fill);
    assert.ok(ratio >= 4.5, `${theme.id}: white on --danger-fill is ${ratio.toFixed(2)}:1`);
  }
});

test("red text is readable on every built-in theme's backgrounds", () => {
  for (const theme of BUILTIN_THEMES) {
    for (const bg of ["--bg-base", "--bg-sidebar", "--bg-channel"] as const) {
      const ratio = contrast(theme.vars["--danger"], theme.vars[bg]);
      assert.ok(ratio >= 4.5, `${theme.id}: --danger on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});
