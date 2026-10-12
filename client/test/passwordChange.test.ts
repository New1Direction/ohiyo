// Changing the password: what the form says when the server refuses. A wrong current
// password comes back as 403 so it never reads as a sign-out.
//   node --experimental-strip-types --test test/passwordChange.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { PASSWORD_MIN_LENGTH, passwordChangeMessage } from "../src/lib/apiErrors.ts";

const failed = (status: number, message = "x") => Object.assign(new Error(message), { status });

test("each refusal gets its own plain message", () => {
  assert.equal(passwordChangeMessage(failed(403)), "That isn't your current password.");
  assert.equal(passwordChangeMessage(failed(429)), "Too many tries. Wait a minute, then try again.");
  assert.equal(passwordChangeMessage(failed(400)), `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  assert.match(passwordChangeMessage(failed(401)), /signed out on this device/);
});

test("a network failure or an unknown status is not blamed on the password", () => {
  for (const err of [new TypeError("Failed to fetch"), failed(500), null]) {
    assert.match(passwordChangeMessage(err), /Check your connection/);
  }
});

test("the minimum matches the server's", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
});
