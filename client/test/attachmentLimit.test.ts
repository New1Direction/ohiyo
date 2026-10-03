// M7: the server refuses a message with more than 10 attachments (400). The composer
// takes at most 10 (pending or still uploading) and says so when more are added.
//   node --experimental-strip-types --test test/attachmentLimit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { filesThatFit } from "../src/lib/attachmentLimit.ts";

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

test("up to 10 files fit and the rest are left out", () => {
  assert.deepEqual(filesThatFit(0, files(12)), { fit: files(10), leftOut: 2 });
});

test("files already attached count toward the 10", () => {
  assert.deepEqual(filesThatFit(8, files(3)), { fit: ["f0", "f1"], leftOut: 1 });
  assert.deepEqual(filesThatFit(10, files(1)), { fit: [], leftOut: 1 });
});

test("files that fit are all taken", () => {
  assert.deepEqual(filesThatFit(2, files(3)), { fit: files(3), leftOut: 0 });
});
