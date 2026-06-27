import assert from "node:assert/strict";
import test from "node:test";
import {
  paddedPlaintextLengthForTest,
  padMessagePlaintext,
  unpadMessagePlaintext,
} from "../src/lib/messagePadding.ts";

test("padding round-trips short encrypted message plaintext", () => {
  const padded = padMessagePlaintext("meet at seven");
  assert.notEqual(padded, "meet at seven");
  assert.equal(unpadMessagePlaintext(padded), "meet at seven");
});

test("old unpadded plaintext stays readable", () => {
  assert.equal(unpadMessagePlaintext("legacy plaintext"), "legacy plaintext");
});

test("same bucket hides small length differences", () => {
  const a = paddedPlaintextLengthForTest("a");
  const b = paddedPlaintextLengthForTest("a slightly longer secret in the same bucket");
  assert.equal(a, b);
});

test("padding bytes are randomized without changing plaintext", () => {
  const one = padMessagePlaintext("same message");
  const two = padMessagePlaintext("same message");
  assert.notEqual(one, two);
  assert.equal(unpadMessagePlaintext(one), "same message");
  assert.equal(unpadMessagePlaintext(two), "same message");
});

test("very large messages are not expanded past the bounded padding window", () => {
  const long = "x".repeat(2500);
  const padded = padMessagePlaintext(long);
  assert.equal(padded, long);
  assert.equal(unpadMessagePlaintext(padded), long);
});
