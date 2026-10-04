import { test } from "node:test";
import assert from "node:assert/strict";
import { clampDreamVolume, dreamDragVolume, dreamGestureMoved, dreamVolumeKey, isDreamDoubleTap } from "../src/lib/dreamGestures.ts";

test("Dream volume clamps finite values and rejects nonfinite input", () => {
  assert.equal(clampDreamVolume(-20), 0);
  assert.equal(clampDreamVolume(150), 100);
  assert.equal(clampDreamVolume(47.8), 48);
  assert.equal(clampDreamVolume(NaN), 0);
  assert.equal(clampDreamVolume(Infinity), 0);
});
test("relative volume drag starts at actual volume; up raises and down lowers", () => {
  assert.equal(dreamDragVolume(35, 200, 200, 200), 35);
  assert.equal(dreamDragVolume(35, 200, 150, 200), 60);
  assert.equal(dreamDragVolume(35, 200, 250, 200), 10);
  assert.equal(dreamDragVolume(35, 200, -1000, 200), 100);
  assert.equal(dreamDragVolume(35, 200, 1000, 200), 0);
  assert.ok(Number.isFinite(dreamDragVolume(35, 200, 150, 0)));
});
test("movement threshold distinguishes a tap from a drag", () => {
  const start = { x: 100, y: 100, at: 10 };
  assert.equal(dreamGestureMoved(start, { x: 102, y: 102, at: 50 }), false);
  assert.equal(dreamGestureMoved(start, { x: 100, y: 107, at: 50 }), true);
  assert.equal(dreamGestureMoved(start, { x: 107, y: 100, at: 50 }), true);
});
test("double tap requires a recent nearby tap and monotonic time", () => {
  const first = { x: 100, y: 100, at: 1000 };
  assert.equal(isDreamDoubleTap(null, first), false);
  assert.equal(isDreamDoubleTap(first, { x: 104, y: 103, at: 1200 }), true);
  assert.equal(isDreamDoubleTap(first, { x: 100, y: 100, at: 1400 }), false);
  assert.equal(isDreamDoubleTap(first, { x: 130, y: 100, at: 1200 }), false);
  assert.equal(isDreamDoubleTap(first, { x: 100, y: 100, at: 900 }), false);
});
test("keyboard volume supports arrows, page keys, Home, End and clamps", () => {
  assert.equal(dreamVolumeKey(98, "ArrowUp"), 100);
  assert.equal(dreamVolumeKey(2, "ArrowDown"), 0);
  assert.equal(dreamVolumeKey(35, "ArrowRight"), 40);
  assert.equal(dreamVolumeKey(35, "ArrowLeft"), 30);
  assert.equal(dreamVolumeKey(35, "PageUp"), 45);
  assert.equal(dreamVolumeKey(35, "PageDown"), 25);
  assert.equal(dreamVolumeKey(35, "Home"), 0);
  assert.equal(dreamVolumeKey(35, "End"), 100);
  assert.equal(dreamVolumeKey(35, "Enter"), null);
});
