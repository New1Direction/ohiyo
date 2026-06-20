// Runs every *.test.mjs in this directory sequentially against a running stack.
// Prereqs: server on :3000 and Vite on :1420 (see README). Exits non-zero on any failure.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2]; // optional substring filter, e.g. `node run.mjs invite`
const tests = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !only || f.includes(only))
  .sort();

if (tests.length === 0) {
  console.error("No matching test files.");
  process.exit(1);
}

let failed = 0;
const started = Date.now();
for (const t of tests) {
  console.log(`\n━━━━━━━━ ${t} ━━━━━━━━`);
  const r = spawnSync(process.execPath, [join(here, t)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

const secs = Math.round((Date.now() - started) / 1000);
console.log(
  `\n${failed === 0 ? "✅ ALL E2E SUITES PASSED" : `❌ ${failed} suite(s) FAILED`} ` +
    `— ${tests.length} suite(s) in ${secs}s`
);
process.exit(failed === 0 ? 0 : 1);
