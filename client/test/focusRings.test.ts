// Only real controls show a focus ring, and only for keyboard focus. The phone drawer showed a
// bordered box around VOICE CHANNELS that looked like a ring left on the list: it was Settings
// → Voice & video's card style, which shared the sidebar block's class name. And the app-wide
// ring is for :focus-visible on controls, not on a panel or paragraph focused from code
// (tabindex="-1").
//   node --experimental-strip-types --test test/focusRings.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

type Rule = { file: string; selector: string; body: string };

/** Innermost `selector { body }` rules, @media wrappers left out. */
function rules(): Rule[] {
  return files(src, ".css").flatMap((file) => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      file: relative(src, file),
      selector: m[1].trim().replace(/\s+/g, " "),
      body: m[2],
    }));
  });
}

const selectorsOf = (rule: Rule) => rule.selector.split(",").map((s) => s.trim());

test("the sidebar's Voice Channels block is not drawn as a bordered card", () => {
  const voiceBlock = rules().filter((r) => selectorsOf(r).includes(".kc-voice-section"));
  assert.ok(voiceBlock.length >= 1, "the block is styled");
  for (const rule of voiceBlock) {
    assert.doesNotMatch(rule.body, /(^|;|\s)(border|border-radius|background)\s*:/, `${rule.file}: ${rule.selector}`);
  }
  const voiceTab = readFileSync(join(src, "components", "settings", "VoiceTab.tsx"), "utf8");
  assert.doesNotMatch(voiceTab, /"kc-voice-section"/, "Settings has its own class for its cards");
});

test("the app-wide focus ring is keyboard only and skips containers focused from code", () => {
  const ring = rules().find((r) => r.selector.startsWith(":where(button, a, input"));
  assert.ok(ring, "the app-wide ring rule");
  assert.match(ring.selector, /\):focus-visible$/);
  assert.match(ring.selector, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
});

test("no ring on mouse focus, except in text fields", () => {
  const drawsRing = (body: string) =>
    /box-shadow\s*:\s*(?!\s|none)/.test(body) || /outline\s*:\s*(?!\s|none|0)/.test(body);
  const mouseFocus = rules().filter((r) => /:focus(?![-\w])/.test(r.selector) && drawsRing(r.body));
  for (const rule of mouseFocus) {
    for (const sel of selectorsOf(rule).filter((s) => /:focus(?![-\w])/.test(s))) {
      assert.match(sel, /input|textarea|field/, `${rule.file}: ${sel}`);
    }
  }
});
