// Tests for the pure voice-E2EE key helpers (generation, envelope, convergence).
//   node --experimental-strip-types --test test/voiceKey.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRoomKey,
  encodeVoiceEnvelope,
  decodeVoiceEnvelope,
  pickCanonical,
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

test("pickCanonical returns the smallest-id key, or null when empty", () => {
  assert.equal(pickCanonical(new Map()), null);
  const k5 = generateRoomKey();
  const k2 = generateRoomKey();
  const k8 = generateRoomKey();
  const collected = new Map([
    ["user-5", k5],
    ["user-2", k2],
    ["user-8", k8],
  ]);
  const picked = pickCanonical(collected);
  assert.equal(picked?.sourceId, "user-2");
  assert.deepEqual([...picked!.key], [...k2]);
});

test("rotation-on-leave: evicting the smallest-id participant falls back to the next", () => {
  const collected = new Map([
    ["user-2", generateRoomKey()],
    ["user-5", generateRoomKey()],
    ["user-8", generateRoomKey()],
  ]);
  assert.equal(pickCanonical(collected)?.sourceId, "user-2");
  collected.delete("user-2"); // user-2 leaves the call
  assert.equal(pickCanonical(collected)?.sourceId, "user-5", "remaining converge to the next-smallest");
});

test("shouldReplyWithOurs: answer a higher-id announcer so they learn our key", () => {
  assert.equal(shouldReplyWithOurs("user-3", "user-9"), true, "ours wins → send it to them");
  assert.equal(shouldReplyWithOurs("user-9", "user-3"), false, "theirs wins → don't reply");
  assert.equal(shouldReplyWithOurs("user-3", "user-3"), false);
});
