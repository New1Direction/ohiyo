// Tests for the recovery-code backup crypto. crypto.subtle is global in Node 22,
// so the full PBKDF2 + AES-GCM round-trip is exercised here.
//   node --experimental-strip-types --test test/recovery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  encryptBackup,
  decryptBackup,
} from "../src/lib/recovery.ts";

const MATERIAL = {
  "kc:sig:identityKey": JSON.stringify({ t: "kp", pub: "AAA", priv: "BBB" }),
  "kc:sk:group1": "chainkey-blob",
  "kc:e2e-keypair": "legacy-keypair",
};

test("generateRecoveryCode is high-entropy, grouped, and unique", () => {
  const a = generateRecoveryCode();
  const b = generateRecoveryCode();
  assert.match(a, /^[A-Z0-9]{4,6}(-[A-Z0-9]{4,6})+$/);
  assert.notEqual(a, b);
  assert.ok(normalizeRecoveryCode(a).length >= 20, "too short for strong entropy");
});

test("normalizeRecoveryCode ignores formatting (case, dashes, spaces)", () => {
  assert.equal(normalizeRecoveryCode("ab12-cd34"), "AB12CD34");
  assert.equal(normalizeRecoveryCode("  Ab 12Cd34 "), "AB12CD34");
});

test("encrypt -> decrypt round-trips the key material", async () => {
  const code = generateRecoveryCode();
  const blob = await encryptBackup(code, MATERIAL);
  assert.equal(blob.v, 1);
  assert.ok(blob.salt && blob.iv && blob.ct);
  const out = await decryptBackup(code, blob);
  assert.deepEqual(out, MATERIAL);
});

test("a differently-formatted but equal code still decrypts", async () => {
  const code = generateRecoveryCode();
  const blob = await encryptBackup(code, MATERIAL);
  const messy = ` ${code.toLowerCase().replace(/-/g, " ")} `;
  const out = await decryptBackup(messy, blob);
  assert.deepEqual(out, MATERIAL);
});

test("a wrong code fails to decrypt (does not silently return garbage)", async () => {
  const blob = await encryptBackup(generateRecoveryCode(), MATERIAL);
  await assert.rejects(() => decryptBackup(generateRecoveryCode(), blob));
});

test("ciphertext does not contain the plaintext key material", async () => {
  const blob = await encryptBackup(generateRecoveryCode(), MATERIAL);
  assert.ok(!blob.ct.includes("legacy-keypair"));
  assert.ok(!blob.ct.includes("chainkey-blob"));
});
