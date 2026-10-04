import { test } from "node:test";
import assert from "node:assert/strict";
import { DREAM_MEDIA_QUERY, dreamAvailable } from "../src/lib/dreamAvailability.ts";

test("Dream mode needs a wide window, hover and a fine pointer: no phones, no touch-first tablets", () => {
  // Each clause is load-bearing. Without width a narrow desktop window gets a broken layout;
  // without the pointer clauses a phone held sideways (wide, but touch only) gets Dream.
  assert.match(DREAM_MEDIA_QUERY, /min-width:\s*701px/);
  assert.match(DREAM_MEDIA_QUERY, /any-hover:\s*hover/);
  assert.match(DREAM_MEDIA_QUERY, /any-pointer:\s*fine/);
  assert.equal(DREAM_MEDIA_QUERY.split(" and ").length, 3, "all three clauses must hold");
});

test("dreamAvailable asks the browser for exactly that query and returns its answer", () => {
  const asked: string[] = [];
  for (const matches of [true, false]) {
    assert.equal(dreamAvailable((query) => { asked.push(query); return { matches }; }), matches);
  }
  assert.deepEqual(asked, [DREAM_MEDIA_QUERY, DREAM_MEDIA_QUERY]);
});

test("where the browser cannot answer, Dream stays available instead of vanishing", () => {
  assert.equal(dreamAvailable(undefined), true);
});
