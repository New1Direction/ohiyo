import { test } from "node:test";
import assert from "node:assert/strict";
import { dreamHaloHole } from "../src/lib/dreamHalo.ts";
const viewport = { left: 0, top: 0, width: 1000, height: 700 };
test("mask hole includes fractional viewport edges plus a two-pixel guard", () => {
  assert.deepEqual(dreamHaloHole({ left: 123.75, top: 80.25, width: 600.5, height: 337.75 }, viewport, 1000, 700), { x: 121, y: 78, width: 606, height: 342 });
});
test("hole follows resize, offset and scaled containing blocks", () => {
  assert.deepEqual(dreamHaloHole({ left: 150, top: 110, width: 240, height: 120 }, { left: 50, top: 10, width: 500, height: 350 }, 1000, 700), { x: 198, y: 198, width: 484, height: 244 });
});
test("unknown dimensions fail closed rather than filtering the provider", () => {
  for (const width of [0, -1, NaN, Infinity]) assert.equal(dreamHaloHole({ left: 20, top: 30, width, height: 100 }, viewport, 1000, 700), null);
  assert.equal(dreamHaloHole({ left: 0, top: 0, width: 200, height: 100 }, viewport, 0, 700), null);
});
