// Swiping between the chat, the space/channel drawer and the member list on a phone: when a
// touch becomes a swipe, how far the panel follows the finger, and what is open when it lifts.
//   node --experimental-strip-types --test test/swipeNav.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { endSwipe, moveSwipe, startSwipe, swipeProgress, type Panel, type SwipeOptions } from "../src/lib/swipeNav.ts";

const OPTIONS: SwipeOptions = { viewportWidth: 390, navWidth: 300, membersWidth: 320, canOpenMembers: true, edgeGuard: 0 };

/** A straight swipe from (x0, y0) by (dx, dy) over `ms` milliseconds, in `steps` moves. */
function swipe(open: Panel, x0: number, y0: number, dx: number, dy: number, ms: number, options: Partial<SwipeOptions> = {}, steps = 6) {
  const o = { ...OPTIONS, ...options };
  let s = startSwipe(open, x0, y0, 0, o);
  if (!s) return { result: open, progress: [] as (number | null)[], started: false };
  const progress: (number | null)[] = [];
  for (let i = 1; i <= steps; i++) {
    s = moveSwipe(s, x0 + (dx * i) / steps, y0 + (dy * i) / steps, (ms * i) / steps);
    progress.push(swipeProgress(s)?.openness ?? null);
  }
  return { result: endSwipe(s, x0 + dx, y0 + dy, ms), progress, started: true };
}

test("a long slow swipe right opens the drawer", () => {
  assert.equal(swipe("none", 100, 400, 200, 0, 600).result, "nav");
});

test("a short slow swipe right leaves the chat where it was", () => {
  assert.equal(swipe("none", 100, 400, 50, 0, 600).result, "none");
});

test("a short quick flick right opens the drawer", () => {
  assert.equal(swipe("none", 100, 400, 70, 0, 80).result, "nav");
});

test("scrolling up or down never opens anything, even if it drifts sideways later", () => {
  const o = { ...OPTIONS };
  let s = startSwipe("none", 100, 400, 0, o)!;
  s = moveSwipe(s, 103, 380, 30);
  s = moveSwipe(s, 105, 340, 60);
  s = moveSwipe(s, 260, 330, 120);
  assert.equal(swipeProgress(s), null);
  assert.equal(endSwipe(s, 300, 330, 160), "none");
});

test("nothing moves until the finger has gone far enough to tell the direction", () => {
  const s = moveSwipe(startSwipe("none", 100, 400, 0, OPTIONS)!, 104, 401, 20);
  assert.equal(swipeProgress(s), null);
});

test("the drawer follows the finger as a share of its width", () => {
  const { progress } = swipe("none", 50, 400, 150, 0, 600, {}, 3);
  assert.deepEqual(progress.map((p) => (p === null ? null : Math.round(p * 100))), [17, 33, 50]);
});

test("a swipe left opens the member list, where there is one", () => {
  assert.equal(swipe("none", 300, 400, -220, 0, 600).result, "members");
  assert.equal(swipe("none", 300, 400, -220, 0, 600, { canOpenMembers: false }).result, "none");
});

test("with the drawer open, a swipe left closes it and the drawer follows back", () => {
  const { result, progress } = swipe("nav", 250, 400, -200, 0, 600, {}, 2);
  assert.equal(result, "none");
  assert.ok(progress[0]! < 1 && progress[1]! < progress[0]!, `openness should fall: ${progress}`);
});

test("with the drawer open, a swipe right changes nothing", () => {
  assert.equal(swipe("nav", 200, 400, 150, 0, 300).result, "nav");
});

test("with the member list open, a swipe right closes it and a swipe left changes nothing", () => {
  assert.equal(swipe("members", 100, 400, 200, 0, 600).result, "none");
  assert.equal(swipe("members", 300, 400, -150, 0, 300).result, "members");
});

test("a swipe that starts at the very edge is left to the browser's own back and forward swipes", () => {
  const guarded = { edgeGuard: 20 };
  assert.equal(swipe("none", 8, 400, 200, 0, 300, guarded).started, false);
  assert.equal(swipe("none", 385, 400, -200, 0, 300, guarded).started, false);
  assert.equal(swipe("none", 40, 400, 200, 0, 300, guarded).result, "nav");
});

test("a swipe that comes back to where it started stays put, however fast", () => {
  const o = { ...OPTIONS };
  let s = startSwipe("none", 100, 400, 0, o)!;
  s = moveSwipe(s, 220, 400, 60);
  s = moveSwipe(s, 110, 400, 90);
  assert.equal(endSwipe(s, 100, 400, 100), "none");
});
