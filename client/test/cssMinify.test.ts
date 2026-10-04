// The dev server does not minify CSS and the production build does, so a CSS bug that only
// the production pipeline causes passes every test that runs against the dev server.
//
// This one did: with `backdrop-filter` written before `-webkit-backdrop-filter` (same value),
// the production build kept only the -webkit- one. Chrome, Edge and Firefox do not implement
// the -webkit- form, so Dream mode's glow and the blur behind modals vanished in production
// while looking fine in development. So this test runs the real production build and checks
// the CSS it emits.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(clientRoot, "src");
const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith(".css") ? [path] : [];
  });

const key = (selector: string) => selector.replace(/\s+/g, "").replace(/^.*\}/, "");
const rulesOf = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: key(m[1]), body: m[2] }));
const hasStandard = (body: string) => /(?<!-webkit-)backdrop-filter\s*:/.test(body);

let built = "";
before(async () => {
  const result = await build({
    root: clientRoot,
    logLevel: "silent",
    build: { write: false, outDir: join(clientRoot, "node_modules", ".cache", "css-minify-test") },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []));
  built = outputs
    .filter((o) => o.type === "asset" && o.fileName.endsWith(".css"))
    .map((o) => String((o as { source: string | Uint8Array }).source))
    .join("\n");
  assert.ok(built.length > 1000, "the production build produced CSS");
});

test("the production build keeps the standard backdrop-filter wherever the source has it", () => {
  const after = rulesOf(built);
  const lost: string[] = [];
  for (const file of cssFiles(src)) {
    for (const rule of rulesOf(readFileSync(file, "utf8"))) {
      if (!hasStandard(rule.body) || rule.selector.includes(",")) continue;
      const kept = after.filter((r) => r.selector === rule.selector && /backdrop-filter/.test(r.body));
      if (kept.length > 0 && !kept.some((r) => hasStandard(r.body))) lost.push(rule.selector);
    }
  }
  assert.deepEqual(lost, [], "the production build left only -webkit-backdrop-filter on these rules");
});
