// When you send an encrypted message, two things answer it: the server's reply to the send,
// and the same message echoed back over the live connection. Nobody can decrypt their own
// outgoing ciphertext, so only the send knows the text. Whichever of the two lands second
// must not undo the first. Before, the echo's failed decrypt won either way, and your own
// message turned into "This message needs keys this device doesn't have" until a reload.
//   node --experimental-strip-types --test test/ownEcho.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { afterDecryptAttempt, withOwnPlaintext } from "../src/lib/ownEcho.ts";

type Shown = { id: string; content: string; attachments?: string[]; _encrypted?: boolean; _decryptState?: "unknown" | "not_covered" | "restore_failed" };

const echoed: Shown = { id: "m1", content: "sig1.AAAA" };
const failedAttempt: Shown = { id: "m1", content: "", _encrypted: true, _decryptState: "unknown" };

test("the echo's failed decrypt lands first: the send's reply still shows the text", () => {
  const afterEcho = afterDecryptAttempt(echoed, failedAttempt);
  assert.deepEqual(afterEcho, failedAttempt);
  const shown = withOwnPlaintext(afterEcho, "still up?");
  assert.equal(shown.content, "still up?");
  assert.equal(shown._encrypted, true);
  assert.equal("_decryptState" in shown, false, "the can't-decrypt notice is gone");
});

test("the send's reply lands first: a failed decrypt that finishes later changes nothing", () => {
  const sent = withOwnPlaintext(echoed, "still up?");
  assert.equal(afterDecryptAttempt(sent, failedAttempt), sent);
});

test("a message that really can't be decrypted still shows as such", () => {
  // Someone else's message: nothing has made it readable, so the failed attempt stands.
  assert.deepEqual(afterDecryptAttempt(echoed, failedAttempt), failedAttempt);
  // And a failed attempt replaces an earlier failed attempt (the reason may have changed).
  const restoreFailed: Shown = { ...failedAttempt, _decryptState: "restore_failed" };
  assert.deepEqual(afterDecryptAttempt(failedAttempt, restoreFailed), restoreFailed);
});

test("a decrypt that worked always wins", () => {
  const decrypted: Shown = { id: "m1", content: "hello", _encrypted: true };
  assert.deepEqual(afterDecryptAttempt(echoed, decrypted), decrypted);
  assert.deepEqual(afterDecryptAttempt(failedAttempt, decrypted), decrypted);
  assert.deepEqual(afterDecryptAttempt(withOwnPlaintext(echoed, "old text"), decrypted), decrypted);
});

test("sent attachments replace the echo's, and are kept when none are given", () => {
  const withFiles: Shown = { ...echoed, attachments: ["sealed"] };
  assert.deepEqual(withOwnPlaintext(withFiles, "see this", ["opened"]).attachments, ["opened"]);
  assert.deepEqual(withOwnPlaintext(withFiles, "see this").attachments, ["sealed"]);
});
