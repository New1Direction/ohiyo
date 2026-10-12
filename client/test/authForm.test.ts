// The sign-up form's username rule. New names use letters, numbers, dots, dashes and
// underscores (the server refuses anything else); signing in checks only the length, so
// names made before the rule still sign in.
//   node --experimental-strip-types --test test/authForm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { friendlyAuthError, usernameProblem, USERNAME_RULE } from "../src/lib/authForm.ts";

test("the rule is said in plain words", () => {
  assert.equal(USERNAME_RULE, "Letters, numbers, dots, dashes and underscores.");
});

test("a name made of allowed characters is fine", () => {
  assert.equal(usernameProblem("ab", "register"), null);
  assert.equal(usernameProblem("Dots.and-dashes_9", "register"), null);
  assert.equal(usernameProblem(" alice ", "register"), null, "the name is sent trimmed");
});

test("a short or long name says which", () => {
  assert.equal(usernameProblem("a", "register"), "A little longer — 2+ characters.");
  assert.equal(usernameProblem("x".repeat(33), "register"), "Keep it under 32 characters.");
});

test("a space or another character is pointed out by name", () => {
  assert.equal(usernameProblem("has space", "register"), "No spaces — letters, numbers, dots, dashes and underscores only.");
  assert.equal(usernameProblem("at@sign", "register"), "\"@\" can't go in a username — letters, numbers, dots, dashes and underscores only.");
  assert.equal(usernameProblem("émile", "register"), "\"é\" can't go in a username — letters, numbers, dots, dashes and underscores only.");
});

test("signing in with an older name that has other characters is allowed", () => {
  assert.equal(usernameProblem("Old Name!", "login"), null);
  assert.equal(usernameProblem("a", "login"), "A little longer — 2+ characters.");
});

test("the server's refusal of a character shows the rule, not the length", () => {
  assert.equal(
    friendlyAuthError("usernames can use letters, numbers, dots, underscores and dashes", "register"),
    "Usernames can use letters, numbers, dots, dashes and underscores.",
  );
  assert.equal(friendlyAuthError("username must be 2–32 chars", "register"), "Usernames are 2–32 characters.");
  assert.equal(friendlyAuthError("username taken", "register"), "That username's already taken — try another?");
  assert.equal(friendlyAuthError("invalid credentials", "login"), "Hmm, that username or password doesn't match.");
});
