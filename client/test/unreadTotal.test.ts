// The number on the dock icon and in the tab title. It has to be a whole number whatever
// the server or a bug puts in the map.
//   node --experimental-strip-types --test test/unreadTotal.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { unreadTotal, withoutUnread } from "../src/lib/unreadTotal.ts";

test("it adds up every chat", () => {
  assert.equal(unreadTotal({}), 0);
  assert.equal(unreadTotal({ a: 2, b: 5 }), 7);
});

test("anything that is not a clean count is left out", () => {
  const odd = { a: 3, b: -4, c: Number.NaN, d: 2.7, e: Number.POSITIVE_INFINITY } as Record<string, number>;
  // 3, plus 2 from the 2.7; the rest count for nothing.
  assert.equal(unreadTotal(odd), 5);
  assert.equal(unreadTotal({ a: undefined as unknown as number, b: "9" as unknown as number }), 0);
});

test("marking a chat read removes it and leaves the others", () => {
  assert.deepEqual(withoutUnread({ a: 2, b: 5 }, "a"), { b: 5 });
});

test("marking a chat read that has nothing unread changes nothing", () => {
  const unread = { b: 5 };
  // The same object, so React skips the re-render.
  assert.equal(withoutUnread(unread, "a"), unread);
});
