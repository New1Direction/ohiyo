// After this device was cut off (a reconnect, or a connection that fell behind), the open
// chat catches up from the server's latest page instead of missing what happened.
//   node --experimental-strip-types --test test/catchUp.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { catchUpMessages } from "../src/lib/catchUp.ts";
import type { Message } from "../src/api.ts";

const msg = (id: string, at: number, content = id, extra: Partial<Message> = {}): Message =>
  ({ id, channel_id: "c", content, created_at: at, author: { id: "u", username: "u", display_name: "U", avatar_url: null }, ...extra }) as Message;
const ids = (list: Message[]) => list.map((m) => m.id);

test("a message sent while this device was cut off shows up", () => {
  const out = catchUpMessages([msg("a", 1), msg("b", 2)], [msg("a", 1), msg("b", 2), msg("c", 3)], []);
  assert.deepEqual(ids(out), ["a", "b", "c"]);
});

test("an edit made meanwhile shows", () => {
  const out = catchUpMessages([msg("a", 1, "before")], [msg("a", 1, "after")], []);
  assert.equal(out[0].content, "after");
});

test("a message deleted meanwhile goes", () => {
  const out = catchUpMessages([msg("a", 1), msg("b", 2)], [msg("a", 1)], []);
  assert.deepEqual(ids(out), ["a"]);
});

test("older history already on screen stays", () => {
  const current = [msg("o1", 1), msg("o2", 2), msg("a", 5), msg("b", 6)];
  const out = catchUpMessages(current, [msg("a", 5), msg("b", 6), msg("c", 7)], []);
  assert.deepEqual(ids(out), ["o1", "o2", "a", "b", "c"]);
});

test("unsent messages stay at the end, once", () => {
  const unsent = msg("temp-1", 9, "on its way", { _state: "pending" });
  const out = catchUpMessages([msg("a", 1), unsent], [msg("a", 1), msg("b", 2)], [unsent]);
  assert.deepEqual(ids(out), ["a", "b", "temp-1"]);
});

test("a chat the server now has empty keeps only what is unsent", () => {
  const unsent = msg("temp-1", 9, "on its way", { _state: "failed" });
  const out = catchUpMessages([msg("a", 1)], [], [unsent]);
  assert.deepEqual(ids(out), ["temp-1"]);
});
