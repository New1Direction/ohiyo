// Where the red "New messages" line goes when you open a chat with unread messages, and what
// the bar above the chat says. The unread count is the server's: messages from other people
// newer than your read mark, so the line sits above the oldest of the last `unread` messages
// from others.
//   node --experimental-strip-types --test test/unreadMarker.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUnreadId, unreadBarLabel } from "../src/lib/unreadMarker.ts";

const ME = "me";
const msg = (id: string, author: string, created_at = 0) => ({ id, author: { id: author }, created_at });

test("nothing unread means no line", () => {
  assert.equal(firstUnreadId([msg("a", "bea"), msg("b", "bea")], 0, ME), null);
});

test("the line sits above the oldest of the unread messages from others", () => {
  const messages = [msg("a", "bea"), msg("b", "bea"), msg("c", "cal"), msg("d", "bea")];
  assert.equal(firstUnreadId(messages, 2, ME), "c");
  assert.equal(firstUnreadId(messages, 3, ME), "b");
});

test("your own messages don't count, wherever they fall", () => {
  // Bea wrote b, you answered, then Bea wrote d: two unread from others is b and d.
  const messages = [msg("a", "bea"), msg("b", "bea"), msg("mine", ME), msg("d", "bea")];
  assert.equal(firstUnreadId(messages, 2, ME), "b");
  // A message you are still sending is yours too.
  const sending = [msg("a", "bea"), msg("temp-1", ME), msg("b", "bea")];
  assert.equal(firstUnreadId(sending, 1, ME), "b");
});

test("when the first unread message isn't loaded yet, say so", () => {
  const messages = [msg("a", "bea"), msg("mine", ME), msg("b", "bea")];
  assert.equal(firstUnreadId(messages, 5, ME), "older");
  assert.equal(firstUnreadId([], 1, ME), "older");
});

test("every loaded message from others being unread puts the line at the very top", () => {
  const messages = [msg("a", "bea"), msg("b", "bea")];
  assert.equal(firstUnreadId(messages, 2, ME), "a");
});

const NOON = Date.UTC(2026, 9, 12, 12, 0, 0); // 12 Oct 2026, 12:00 UTC
const fmt = { locale: "en-US", timeZone: "UTC" };

test("the bar says how many and since when", () => {
  const since = Date.UTC(2026, 9, 12, 9, 7, 0) / 1000;
  assert.equal(unreadBarLabel(1, since, NOON, fmt), "1 new message since 9:07 AM");
  assert.equal(unreadBarLabel(12, since, NOON, fmt), "12 new messages since 9:07 AM");
});

test("an earlier day names the day", () => {
  const since = Date.UTC(2026, 9, 10, 18, 30, 0) / 1000;
  assert.equal(unreadBarLabel(3, since, NOON, fmt), "3 new messages since Oct 10 at 6:30 PM");
});

test("without a time (the first one isn't loaded) the bar just counts", () => {
  assert.equal(unreadBarLabel(250, null, NOON, fmt), "250 new messages");
});
