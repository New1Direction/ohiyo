// The small rules behind two-factor sign-in in the app: telling a sign-in that needs a code
// from one that's done, what a typed code is, the recovery-codes file, the messages people
// see, and when another device's change is worth a word.
//   node --experimental-strip-types --test test/twoFactor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codeKind,
  isTwoFactorChallenge,
  recoveryCodesText,
  shouldAnnounceTwoFactorChange,
  signInCodeMessage,
  stepUpCodeMessage,
} from "../src/lib/twoFactor.ts";

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

test("a sign-in that needs a code is told apart from one that's done", () => {
  assert.equal(isTwoFactorChallenge({ two_factor_required: true, challenge: "abc", expires_in: 300 }), true);
  assert.equal(isTwoFactorChallenge({ token: "t", user: { id: "u" } }), false);
  assert.equal(isTwoFactorChallenge({ two_factor_required: true }), false, "no challenge, nothing to answer");
  assert.equal(isTwoFactorChallenge(null), false);
});

test("a typed code is a 6-digit code, a recovery code, or not yet either", () => {
  assert.equal(codeKind("123456"), "totp");
  assert.equal(codeKind(" 123 456 "), "totp");
  assert.equal(codeKind("12345"), null);
  assert.equal(codeKind("1234567"), null);
  assert.equal(codeKind("ABCD-EFGH-JKLM-NPQR"), "recovery");
  assert.equal(codeKind("abcd efgh jklm npqr"), "recovery");
  assert.equal(codeKind("ABCDEFGHJKLMNPQR"), "recovery");
  assert.equal(codeKind("ABCD-EFGH"), null);
  assert.equal(codeKind("ABCD-EFGH-JKLM-NP01"), null, "0 and 1 aren't in a recovery code");
  assert.equal(codeKind(""), null);
});

test("the recovery-codes file names the account, says how they work, and lists every code", () => {
  const codes = ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"];
  const text = recoveryCodesText(codes, "alice", new Date("2026-10-12T12:00:00Z"));
  assert.match(text, /@alice/);
  assert.match(text, /2026-10-12/);
  assert.match(text, /once/i, "says each code works once");
  for (const code of codes) assert.ok(text.includes(code), code);
  assert.ok(text.endsWith("\n"));
});

test("the sign-in step says plainly what went wrong", () => {
  assert.match(signInCodeMessage(apiError(403, "that code isn't right")), /isn't right/);
  assert.match(signInCodeMessage(apiError(401, "sign in again")), /sign in again/i);
  assert.match(signInCodeMessage(apiError(429, "too many attempts")), /wait a minute/i);
  assert.equal(
    signInCodeMessage(apiError(429, "Too many codes tried. Try again in a while.")),
    "Too many codes tried. Try again in a while.",
    "the hourly limit isn't a minute's wait",
  );
  assert.match(signInCodeMessage(new TypeError("Failed to fetch")), /can't reach/i);
});

test("a settings form asking for a code says so, and leaves other refusals to the form", () => {
  assert.match(stepUpCodeMessage(apiError(403, "enter the code from your authenticator app")) ?? "", /code from your authenticator app/);
  assert.match(stepUpCodeMessage(apiError(403, "that code isn't right")) ?? "", /isn't right/);
  assert.equal(stepUpCodeMessage(apiError(403, "that isn't your password")), null);
  assert.equal(stepUpCodeMessage(apiError(400, "password must be ≥8 chars")), null);
  assert.equal(
    stepUpCodeMessage(apiError(429, "Too many codes tried. Try again in a while.")),
    "Too many codes tried. Try again in a while.",
  );
});

test("another device's change is announced, this device's own change isn't", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldAnnounceTwoFactorChange(null, now), true);
  assert.equal(shouldAnnounceTwoFactorChange(now - 2_000, now), false, "changed here a moment ago");
  assert.equal(shouldAnnounceTwoFactorChange(now - 60_000, now), true, "long ago: it was somewhere else");
});
