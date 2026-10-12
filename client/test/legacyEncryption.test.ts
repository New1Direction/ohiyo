// The first encrypted-DM format ("v1.", sent for one day in June 2026) took its key from a
// public key the server handed out, with nothing to check it against. So a server could
// forge a "v1." message that showed as encrypted, from your contact. Nothing reads or
// writes that format any more; this keeps it that way.
//   node --experimental-strip-types --test test/legacyEncryption.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import * as e2e from "../src/lib/e2e.ts";

test("nothing in the app can open or write the old static-key format", () => {
  assert.equal("decryptMessage" in e2e, false);
  assert.equal("encryptMessage" in e2e, false);
});

test("an old v1 message is still recognised, so it shows as unreadable, not as text", () => {
  assert.equal(e2e.isEncrypted("v1.AAAAAAAAAAAAAAAA.BBBB"), true);
});
