// Every third-party action in .github/workflows is pinned to a full commit, not a tag or a
// branch. A tag can be moved to other code at any time, and release.yml hands the update
// signing key and a write token to the actions it runs. Dependabot (github-actions) keeps
// the pins current and reads the version from the trailing comment.
//   node --experimental-strip-types --test test/workflowPins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflows = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));

function usesLines(file: string): { line: number; ref: string; comment: string }[] {
  return readFileSync(join(workflows, file), "utf8")
    .split("\n")
    .flatMap((text, i) => {
      const m = text.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(?:#\s*(.*))?$/);
      return m ? [{ line: i + 1, ref: m[1], comment: (m[2] ?? "").trim() }] : [];
    });
}

test("every third-party action is pinned to a full commit, with its version in a comment", () => {
  let checked = 0;
  for (const file of files) {
    for (const { line, ref, comment } of usesLines(file)) {
      if (ref.startsWith("./")) continue;
      checked += 1;
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}:${line} pins ${ref} to a commit`);
      assert.match(comment, /^v?\d|^stable$/, `${file}:${line} says which version ${ref} is`);
    }
  }
  assert.ok(checked > 0, "found the workflows' actions");
});

test("rust-toolchain pinned to a commit still says which toolchain to install", () => {
  // With @stable the action takes the toolchain from the ref; with a commit it can't.
  for (const file of files) {
    const text = readFileSync(join(workflows, file), "utf8");
    const steps = text.split(/\n(?=\s*- )/);
    for (const step of steps) {
      if (!/uses:\s*dtolnay\/rust-toolchain@/.test(step)) continue;
      assert.match(step, /toolchain:\s*stable/, `${file}: rust-toolchain step names the toolchain`);
    }
  }
});
