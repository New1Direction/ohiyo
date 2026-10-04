// I1: editing a decrypted message re-sends its text. With the lock off the edit would go
// out unencrypted, uploading the decrypted plaintext, so it is refused (like forward), at
// the place the edit is sent; ChatPane doesn't offer it either.
//   node --experimental-strip-types --test test/editGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { editBlockReason } from "../src/lib/encryptedSend.ts";

test("a decrypted message can't be edited while the chat isn't in encrypted mode", () => {
  assert.equal(editBlockReason({ _encrypted: true }, false), "Turn encryption back on to edit this message.");
});

test("a decrypted message can be edited in encrypted mode, where the edit is encrypted", () => {
  assert.equal(editBlockReason({ _encrypted: true }, true), null);
});

test("a plain message can be edited either way", () => {
  assert.equal(editBlockReason({}, false), null);
  assert.equal(editBlockReason({ _encrypted: false }, true), null);
});
