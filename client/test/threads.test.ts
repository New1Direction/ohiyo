// Threads: a reply chain that starts from one message in a space's text channel.
// The pure parts: the name a new thread starts with, the line under a message that has
// a thread, keeping a channel's thread list in order, and which chats can have threads.
//   node --experimental-strip-types --test test/threads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canStartThread,
  defaultThreadName,
  threadChipLabel,
  threadsByMessage,
  upsertThread,
  type ThreadSummary,
} from "../src/lib/threads.ts";

const NOW = 1_800_000_000; // seconds

function thread(id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    server_id: "s1",
    name: id,
    channel_type: "text",
    position: 0,
    topic: null,
    created_at: NOW - 1000,
    parent_id: "c1",
    thread_message_id: `m-${id}`,
    message_count: 0,
    last_message_at: null,
    starter_deleted: false,
    ...patch,
  };
}

test("a new thread is named after the first line of its message", () => {
  assert.equal(defaultThreadName("Plans for Saturday\nmore below"), "Plans for Saturday");
  assert.equal(defaultThreadName("   \n  spaced   out   words  "), "spaced out words");
});

test("a long first line is cut at a word, with an ellipsis", () => {
  const name = defaultThreadName("This is a very long message that goes on and on about the game tonight");
  assert.ok(name.length <= 41, name);
  assert.ok(name.endsWith("…"), name);
  assert.ok(name.startsWith("This is a very long message"), name);
  assert.ok(!name.includes("  "));
});

test("a message with no words still gives a thread a name", () => {
  assert.equal(defaultThreadName(""), "Thread");
  assert.equal(defaultThreadName("   \n "), "Thread");
});

test("the line under a message counts the replies and says when the last one came", () => {
  assert.equal(threadChipLabel(0, null, NOW), "No replies yet");
  assert.equal(threadChipLabel(1, NOW - 10, NOW), "1 reply · just now");
  assert.equal(threadChipLabel(3, NOW - 5 * 60, NOW), "3 replies · last reply 5m ago");
  assert.equal(threadChipLabel(12, NOW - 2 * 3600, NOW), "12 replies · last reply 2h ago");
  assert.equal(threadChipLabel(2, NOW - 3 * 86400, NOW), "2 replies · last reply 3d ago");
});

test("a channel's threads stay ordered by their latest activity", () => {
  const quiet = thread("quiet", { created_at: NOW - 5000 });
  const busy = thread("busy", { created_at: NOW - 9000, last_message_at: NOW - 100 });
  let list = upsertThread([], quiet);
  list = upsertThread(list, busy);
  assert.deepEqual(list.map((t) => t.id), ["busy", "quiet"]);

  // A reply in the quiet one moves it up, and the same thread is never listed twice.
  list = upsertThread(list, { ...quiet, message_count: 1, last_message_at: NOW - 10 });
  assert.deepEqual(list.map((t) => t.id), ["quiet", "busy"]);
  assert.equal(list.find((t) => t.id === "quiet")?.message_count, 1);
});

test("a thread is found from the message it started on", () => {
  const map = threadsByMessage([thread("a"), thread("b", { thread_message_id: null })]);
  assert.equal(map.get("m-a")?.id, "a");
  assert.equal(map.size, 1, "a thread whose first message is gone has no message to sit under");
});

test("only a space's text channels can have threads", () => {
  const base = { id: "c", name: "c", position: 0, topic: null, created_at: 0 };
  assert.equal(canStartThread({ ...base, server_id: "s", channel_type: "text" }), true);
  assert.equal(canStartThread({ ...base, server_id: "s", channel_type: "voice" }), false);
  assert.equal(canStartThread({ ...base, server_id: null, channel_type: "dm" }), false);
  assert.equal(canStartThread({ ...base, server_id: null, channel_type: "group_dm" }), false);
  assert.equal(
    canStartThread({ ...base, server_id: "s", channel_type: "text", parent_id: "c0" }),
    false,
    "no thread inside a thread"
  );
});
