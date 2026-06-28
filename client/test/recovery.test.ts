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
  backupSummary,
  backupCoversSenderKey,
  type BackupBlobV1,
} from "../src/lib/recovery.ts";

const MATERIAL = {
  "kc:sig:identityKey": JSON.stringify({ t: "kp", pub: "AAA", priv: "BBB" }),
  "kc:sig:deviceId": "42",
  "kc:sk:own:group1": JSON.stringify({ keyId: 123, chainKey: "chain", iteration: 7, verifyKey: "vk", epoch: 2 }),
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

test("encrypt -> decrypt round-trips v2 key material", async () => {
  const code = generateRecoveryCode();
  const blob = await encryptBackup(code, MATERIAL);
  assert.equal(blob.v, 2);
  assert.ok(blob.salt && blob.iv && blob.ct);
  assert.equal(blob.public_manifest.entry_count, Object.keys(MATERIAL).length);
  assert.equal(blob.public_manifest.room_blinds.length, 1);
  assert.equal(blob.public_manifest.key_blinds.length, 1);
  const out = await decryptBackup(code, blob);
  assert.deepEqual(out, MATERIAL);
});

test("v2 public manifest exposes coverage, not clear room ids or key material", async () => {
  const blob = await encryptBackup(generateRecoveryCode(), MATERIAL);
  const serialized = JSON.stringify(blob);
  assert.ok(!serialized.includes("group1"));
  assert.ok(!serialized.includes("legacy-keypair"));
  assert.ok(!serialized.includes("chainkey-blob"));
  assert.ok(!serialized.includes("chain\""));
  const summary = backupSummary(blob);
  assert.equal(summary.version, 2);
  assert.equal(summary.room_count, 1);
  assert.equal(summary.key_count, 1);
});

test("coverage checks are recovery-secret gated, not server-enumerable", async () => {
  const code = generateRecoveryCode();
  const blob = await encryptBackup(code, MATERIAL);
  assert.equal(await backupCoversSenderKey(code, blob, "group1", 2, 123), "covered");
  assert.equal(await backupCoversSenderKey(generateRecoveryCode(), blob, "group1", 2, 123), "not_covered");
  assert.equal(await backupCoversSenderKey(code, blob, "group1", 3, 123), "not_covered");

  // Server vantage: it knows the room id, plausible epochs/key ids, and public salt,
  // but not the recovery-derived blind key. HMACing those low-entropy candidates under
  // server-known guesses must not reproduce the manifest handles.
  const enc = new TextEncoder();
  async function hmacWithRawKey(raw: string, label: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", enc.encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(label));
    return Buffer.from(new Uint8Array(sig)).toString("base64");
  }
  const publicGuesses = ["public", blob.salt, "account-id", "group1", "42"];
  const labels = ["room:group1", "grp1:group1:2:123"];
  for (const guess of publicGuesses) {
    for (const label of labels) {
      const forged = await hmacWithRawKey(guess, label);
      assert.ok(!blob.public_manifest.room_blinds.includes(forged));
      assert.ok(!blob.public_manifest.key_blinds.includes(forged));
    }
  }
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

test("v1 flat backups remain readable", async () => {
  const code = generateRecoveryCode();
  // Minimal v1 fixture produced with the old shape, using the current public API would
  // always emit v2. This fixture proves restore-read keeps legacy users alive.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = new TextEncoder().encode(normalizeRecoveryCode(code));
  const baseKey = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const pt = new TextEncoder().encode(JSON.stringify(MATERIAL));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  const toB64 = (buf: ArrayBuffer) => Buffer.from(new Uint8Array(buf)).toString("base64");
  const blob: BackupBlobV1 = { v: 1, salt: toB64(salt.buffer), iv: toB64(iv.buffer), ct: toB64(ct) };
  assert.deepEqual(await decryptBackup(code, blob), MATERIAL);
});
