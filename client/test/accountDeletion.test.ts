// Deleting the account: what the form says when the server refuses. Every refusal
// deleted nothing, and says so.
//   node --experimental-strip-types --test test/accountDeletion.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteAccountMessage } from "../src/lib/apiErrors.ts";

const failed = (status: number) => Object.assign(new Error("x"), { status });

test("each refusal says what went wrong and that nothing was deleted", () => {
  assert.match(deleteAccountMessage(failed(403)), /isn't your password\. Nothing was deleted/);
  assert.match(deleteAccountMessage(failed(400)), /username exactly.*Nothing was deleted/);
  assert.match(deleteAccountMessage(failed(502)), /Instant Server.*nothing was deleted/);
  assert.match(deleteAccountMessage(failed(429)), /Too many tries/);
  assert.match(deleteAccountMessage(failed(401)), /session has ended/);
});

test("a network failure says nothing was deleted, and blames the connection", () => {
  assert.match(deleteAccountMessage(new TypeError("Failed to fetch")), /connection.*Nothing was deleted/);
});
