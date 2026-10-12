// Deleting the account: what the form says when it doesn't go through. A refusal deleted
// nothing, and says so. When the answer was lost (a dropped connection, a timeout, a proxy
// in front of the server failing) the account may already be gone, so the form must not
// promise that nothing was deleted.
//   node --experimental-strip-types --test test/accountDeletion.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteAccountMessage } from "../src/lib/apiErrors.ts";

const failed = (status: number, message = "x") => Object.assign(new Error(message), { status });

test("each refusal says what went wrong and that nothing was deleted", () => {
  assert.match(deleteAccountMessage(failed(403)), /isn't your password\. Nothing was deleted/);
  assert.match(deleteAccountMessage(failed(400)), /username exactly.*Nothing was deleted/);
  assert.match(
    deleteAccountMessage(failed(502, "couldn't shut down your Instant Server")),
    /Instant Server.*nothing was deleted/,
  );
  assert.match(deleteAccountMessage(failed(429)), /Too many tries/);
});

test("when the answer was lost, it doesn't claim nothing was deleted", () => {
  const lost = [
    new TypeError("Failed to fetch"),
    failed(500),
    failed(502, "<html><body>Bad Gateway</body></html>"),
    failed(503),
    failed(504),
  ];
  for (const err of lost) {
    const text = deleteAccountMessage(err);
    assert.doesNotMatch(text, /nothing was deleted/i, text);
    assert.match(text, /couldn't tell/i, text);
  }
});

test("a session that has ended may mean the account is already gone", () => {
  assert.match(deleteAccountMessage(failed(401)), /If you just deleted your account, it's gone/);
});
