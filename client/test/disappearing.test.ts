// The expiry the decrypted-message cache stores for a message. Every cache write (decrypt,
// send, retry, edit) passes the message through messageExpiry, so a disappearing
// message's plaintext is dropped when the message expires, and only a real unix time
// (or null, never) reaches the cache.
//   node --experimental-strip-types --test test/disappearing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { messageExpiry } from "../src/lib/disappearing.ts";

test("a disappearing message's expiry is what the cache stores", () => {
  assert.equal(messageExpiry({ expires_at: 1_800_000_060 }), 1_800_000_060);
});

test("no expiry, no message, or a value that isn't a unix time means never", () => {
  for (const message of [{ expires_at: null }, {}, undefined, null, { expires_at: Number.NaN }, { expires_at: "1800000060" }]) {
    assert.equal(messageExpiry(message as { expires_at?: number | null }), null);
  }
});
