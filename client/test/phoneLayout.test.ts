// Full-height screens must follow the part of the screen a phone's browser leaves visible.
// `100vh` (Tailwind's h-screen) is the whole screen there, which puts the message box behind
// the browser's own bar. A test browser has no such bar, so this is checked in the source.
//   node --experimental-strip-types --test test/phoneLayout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

test("no screen is sized with h-screen", () => {
  const users = sourceFiles(src).filter((path) => /\b(min-)?h-screen\b/.test(readFileSync(path, "utf8")));
  assert.deepEqual(users.map((path) => path.slice(src.length + 1)), [], "use the kc-screen / kc-screen-min classes");
});

test("kc-screen is the visible height, with the old unit as a fallback", () => {
  const css = readFileSync(join(src, "index.css"), "utf8");
  assert.match(css, /\.kc-screen \{ height: 100vh; height: 100dvh; \}/);
  assert.match(css, /\.kc-screen-min \{ min-height: 100vh; min-height: 100dvh; \}/);
});
