// Tests for the pure voice-E2EE key helpers (generation, envelope, convergence).
//   node --experimental-strip-types --test test/voiceKey.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRoomKey,
  encodeVoiceEnvelope,
  decodeVoiceEnvelope,
  shouldAdopt,
  shouldReplyWithOurs,
} from "../src/lib/voiceKey.ts";

test("generateRoomKey is 32 random bytes and unique", () => {
  const a = generateRoomKey();
  const b = generateRoomKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual([...a], [...b]);
});

test("encode -> decode round-trips the key and source id", () => {
  const key = generateRoomKey();
  const json = encodeVoiceEnvelope(key, "user-7");
  const out = decodeVoiceEnvelope(json);
  assert.ok(out);
  assert.deepEqual([...out!.key], [...key]);
  assert.equal(out!.sourceId, "user-7");
});

test("decodeVoiceEnvelope rejects non-voice / malformed / wrong-length payloads", () => {
  assert.equal(decodeVoiceEnvelope("not json"), null);
  assert.equal(decodeVoiceEnvelope(JSON.stringify({ kid: 1, ck: "x" })), null); // a text SKDM
  assert.equal(decodeVoiceEnvelope(JSON.stringify({ v: "vk1", k: "", s: "u" })), null); // empty key
  assert.equal(decodeVoiceEnvelope(JSON.stringify({ v: "vk1", k: btoa("short"), s: "u" })), null);
});

test("shouldAdopt: take a key when we hold none, or it's from a smaller id", () => {
  assert.equal(shouldAdopt(null, "user-9"), true, "no key yet → adopt");
  assert.equal(shouldAdopt("user-9", "user-3"), true, "smaller id wins");
  assert.equal(shouldAdopt("user-3", "user-9"), false, "larger id loses");
  assert.equal(shouldAdopt("user-3", "user-3"), false, "same source → no change");
});

test("shouldReplyWithOurs: answer a losing candidate so the sender converges", () => {
  assert.equal(shouldReplyWithOurs("user-3", "user-9"), true, "their key loses → send them ours");
  assert.equal(shouldReplyWithOurs("user-9", "user-3"), false, "their key wins → don't reply");
  assert.equal(shouldReplyWithOurs("user-3", "user-3"), false);
});

test("convergence: three peers settle on the smallest-id key", () => {
  // Simulate each peer's local (key, sourceId) after gossiping.
  const peers = ["user-5", "user-2", "user-8"];
  // Each starts holding its own candidate.
  const held = new Map(peers.map((p) => [p, p])); // sourceId each currently holds
  // Everyone announces to everyone; adopt the smaller-id source.
  for (const announcer of peers) {
    for (const receiver of peers) {
      if (announcer === receiver) continue;
      if (shouldAdopt(held.get(receiver)!, announcer)) held.set(receiver, announcer);
    }
  }
  for (const p of peers) assert.equal(held.get(p), "user-2", "all converge to the smallest id");
});
