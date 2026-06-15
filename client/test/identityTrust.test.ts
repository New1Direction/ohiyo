// Unit tests for the identity-change / verification trust layer.
//
// Run with the repo's zero-dependency runner (Node 22 strips the types natively):
//   npm run test:unit            (from client/)
//   node --experimental-strip-types --test test/identityTrust.test.ts
//
// This module is deliberately pure (no libsignal/api/crypto imports) so the
// "a swapped identity key raises the change event" guarantee is testable in
// isolation, with an in-memory backend.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setIdentityTrustBackend,
  recordKeySeen,
  identityChanged,
  acknowledgeIdentityChange,
  isVerified,
  markVerified,
  clearVerified,
  trustState,
  onIdentityChange,
  type TrustBackend,
} from "../src/lib/identityTrust.ts";

// A fresh in-memory backend per test so cases don't bleed into each other.
function freshBackend(): TrustBackend {
  const map = new Map<string, string>();
  const backend: TrustBackend = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
  setIdentityTrustBackend(backend);
  return backend;
}

test("a swapped identity key raises the change event", () => {
  freshBackend();
  const fired: string[] = [];
  const off = onIdentityChange((uid) => fired.push(uid));

  // First sight of a key is NOT a change (TOFU): no event, not flagged.
  assert.equal(recordKeySeen("alice", undefined, "KEY_A"), false);
  assert.equal(identityChanged("alice"), false);
  assert.deepEqual(fired, []);

  // Same key seen again is NOT a change.
  assert.equal(recordKeySeen("alice", "KEY_A", "KEY_A"), false);
  assert.deepEqual(fired, []);

  // A DIFFERENT key for a peer we already knew IS a change → flagged + event fires.
  assert.equal(recordKeySeen("alice", "KEY_A", "KEY_B"), true);
  assert.equal(identityChanged("alice"), true);
  assert.deepEqual(fired, ["alice"]);

  off();
});

test("unsubscribe stops the listener", () => {
  freshBackend();
  const fired: string[] = [];
  const off = onIdentityChange((uid) => fired.push(uid));
  off();
  recordKeySeen("bob", "K1", "K2");
  assert.deepEqual(fired, []);
  assert.equal(identityChanged("bob"), true); // still flagged in storage
});

test("a change on a PREVIOUSLY-VERIFIED contact is loud (changed_verified)", () => {
  freshBackend();
  recordKeySeen("carol", undefined, "K1");
  markVerified("carol");
  assert.equal(isVerified("carol"), true);
  assert.equal(trustState("carol"), "verified");

  // Key rotates after verification → loud re-verify state.
  recordKeySeen("carol", "K1", "K2");
  assert.equal(trustState("carol"), "changed_verified");
});

test("a change on an UNVERIFIED contact is calm (changed_unverified)", () => {
  freshBackend();
  recordKeySeen("dave", undefined, "K1");
  recordKeySeen("dave", "K1", "K2");
  assert.equal(trustState("dave"), "changed_unverified");
});

test("markVerified clears a pending change and yields verified", () => {
  freshBackend();
  recordKeySeen("erin", undefined, "K1");
  recordKeySeen("erin", "K1", "K2");
  assert.equal(trustState("erin"), "changed_unverified");

  markVerified("erin");
  assert.equal(identityChanged("erin"), false);
  assert.equal(isVerified("erin"), true);
  assert.equal(trustState("erin"), "verified");
});

test("acknowledging a change clears both change and stale verification", () => {
  freshBackend();
  recordKeySeen("frank", undefined, "K1");
  markVerified("frank");
  recordKeySeen("frank", "K1", "K2"); // changed_verified
  assert.equal(trustState("frank"), "changed_verified");

  // Dismissing without re-verifying must NOT leave the contact "verified" against
  // a key the user never confirmed.
  acknowledgeIdentityChange("frank");
  assert.equal(identityChanged("frank"), false);
  assert.equal(isVerified("frank"), false);
  assert.equal(trustState("frank"), "unverified");
});

test("clearVerified resets to unverified", () => {
  freshBackend();
  recordKeySeen("grace", undefined, "K1");
  markVerified("grace");
  clearVerified("grace");
  assert.equal(isVerified("grace"), false);
  assert.equal(trustState("grace"), "unverified");
});
