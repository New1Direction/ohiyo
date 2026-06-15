// Tests for the pure multi-device safety-number aggregation. crypto.subtle is global
// in Node 22, so the full fingerprint computation runs here.
//   node --experimental-strip-types --test test/safetyNumber.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareKeys,
  combinedIdentity,
  computeSafetyNumber,
} from "../src/lib/safetyNumber.ts";

const keyOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;
const A = keyOf([1, 2, 3, 4]);
const B = keyOf([9, 9, 9, 9]);
const C = keyOf([5, 5, 5, 5]);

test("combinedIdentity is order-independent and dedupes", () => {
  const x = new Uint8Array(combinedIdentity([A, B, C]));
  const y = new Uint8Array(combinedIdentity([C, A, B, A])); // different order + a dupe
  assert.deepEqual([...x], [...y], "same key set → same combined identity");
  // deduped length: 3 distinct keys, each length-prefixed (4) + 4 bytes = 3 * 8 = 24
  assert.equal(x.length, 24);
});

test("length-prefixing prevents cross-set concatenation collisions", () => {
  // Without a length prefix, {[1,2],[3]} and {[1,2,3]} concat identically. With it, they differ.
  const a = new Uint8Array(combinedIdentity([keyOf([1, 2]), keyOf([3])]));
  const b = new Uint8Array(combinedIdentity([keyOf([1, 2, 3])]));
  assert.notDeepEqual([...a], [...b], "different key sets must not collide");
});

test("compareKeys orders by bytes then length", () => {
  assert.ok(compareKeys(A, B) < 0);
  assert.ok(compareKeys(B, A) > 0);
  assert.equal(compareKeys(A, keyOf([1, 2, 3, 4])), 0);
  assert.ok(compareKeys(keyOf([1, 2]), keyOf([1, 2, 0])) < 0, "shorter prefix sorts first");
});

test("computeSafetyNumber is a 60-digit string and deterministic", async () => {
  const n1 = await computeSafetyNumber("alice", [A], "bob", [B]);
  const n2 = await computeSafetyNumber("alice", [A], "bob", [B]);
  assert.equal(n1, n2);
  assert.match(n1!, /^\d{60}$/);
});

test("computeSafetyNumber is symmetric — both peers derive the same value", async () => {
  const fromAlice = await computeSafetyNumber("alice", [A], "bob", [B]);
  const fromBob = await computeSafetyNumber("bob", [B], "alice", [A]);
  assert.equal(fromAlice, fromBob);
});

test("adding a second device to a peer changes the number (aggregation is real)", async () => {
  const oneDevice = await computeSafetyNumber("alice", [A], "bob", [B]);
  const twoDevices = await computeSafetyNumber("alice", [A], "bob", [B, C]);
  assert.notEqual(oneDevice, twoDevices, "a new peer device must change the safety number");
});

test("device-key order on a side doesn't change the number", async () => {
  const x = await computeSafetyNumber("alice", [A], "bob", [B, C]);
  const y = await computeSafetyNumber("alice", [A], "bob", [C, B]);
  assert.equal(x, y, "aggregation sorts keys, so device order is irrelevant");
});

test("returns null when a side has no known key", async () => {
  assert.equal(await computeSafetyNumber("alice", [], "bob", [B]), null);
  assert.equal(await computeSafetyNumber("alice", [A], "bob", []), null);
});
