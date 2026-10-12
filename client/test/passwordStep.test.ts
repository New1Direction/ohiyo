// What the app says when an action that asks for the password again is refused.
//   node --experimental-strip-types --test test/passwordStep.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { passwordStepMessage } from "../src/lib/apiErrors.ts";

const failed = (status: number) => Object.assign(new Error("x"), { status });

test("a wrong password and too many tries are said plainly", () => {
  assert.equal(passwordStepMessage(failed(403), "Couldn't delete the backup"), "That isn't your password.");
  assert.equal(passwordStepMessage(failed(429), "Couldn't delete the backup"), "Too many tries. Wait a minute, then try again.");
});

test("anything else falls back to what the action was", () => {
  assert.equal(passwordStepMessage(failed(500), "Couldn't delete the backup"), "Couldn't delete the backup");
  assert.equal(passwordStepMessage(new TypeError("Failed to fetch"), "Couldn't save"), "Couldn't save");
});
