// M7: the server refuses a message with more than 10 attachments (400). The composer
// takes at most 10 (pending or still uploading) and says so when more are added.
//   node --experimental-strip-types --test test/attachmentLimit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { filesThatFit, holdingSlots } from "../src/lib/attachmentLimit.ts";

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

// N3: the files-in-flight count must come back down however an upload batch ends, or the
// 10-file allowance shrinks for the rest of the chat's life.
test("slots held for an upload batch are given back when it finishes", async () => {
  const slots = { current: 0 };
  assert.equal(await holdingSlots(slots, 3, async () => (assert.equal(slots.current, 3), "done")), "done");
  assert.equal(slots.current, 0);
});

test("slots held for an upload batch are given back when it throws", async () => {
  const slots = { current: 2 };
  await assert.rejects(holdingSlots(slots, 3, async () => { throw new Error("arrayBuffer failed"); }), /arrayBuffer failed/);
  assert.equal(slots.current, 2);
});
