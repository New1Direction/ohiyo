// When does a new message count as seen? Only when its chat is open in a window the
// person can actually see. A desktop window hidden in the tray is not that.
//   node --experimental-strip-types --test test/attention.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { arrivalInOpenChat, isLookingAt, lastRealMessageId } from "../src/lib/attention.ts";

const open = { openChannelId: "c1", messageChannelId: "c1", pageHidden: false, windowHidden: false };

test("the chat is open and on screen", () => {
  assert.equal(isLookingAt(open), true);
});

test("another chat is open, or none", () => {
  assert.equal(isLookingAt({ ...open, openChannelId: "c2" }), false);
  assert.equal(isLookingAt({ ...open, openChannelId: null }), false);
  assert.equal(isLookingAt({ ...open, openChannelId: undefined }), false);
});

test("the chat is open but the tab is in the background", () => {
  assert.equal(isLookingAt({ ...open, pageHidden: true }), false);
});

test("the chat is open but the desktop window is hidden in the tray", () => {
  assert.equal(isLookingAt({ ...open, windowHidden: true }), false);
});

test("a message in the open chat is read when the window is on screen", () => {
  assert.equal(arrivalInOpenChat(false, false), "read");
  assert.equal(arrivalInOpenChat(false, true), "read");
});

test("a message in the open chat while the window is hidden counts as unread", () => {
  assert.equal(arrivalInOpenChat(true, false), "unread");
});

test("your own message from another device is never unread", () => {
  assert.equal(arrivalInOpenChat(true, true), "nothing");
});

test("the read mark is the newest message the server knows", () => {
  assert.equal(lastRealMessageId([{ id: "m1" }, { id: "m2" }, { id: "temp-3" }]), "m2");
  assert.equal(lastRealMessageId([{ id: "temp-1" }]), undefined);
  assert.equal(lastRealMessageId([]), undefined);
});
