// C-M2: signing out removes the decrypted-message cache, the outbox (which holds unsent
// plaintext) and every composer draft from this device, in localStorage and in the
// desktop vault, while identity and Signal session keys stay.
//   node --experimental-strip-types --test test/logoutCleanup.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { clearLocalMessageData } from "../src/lib/logoutCleanup.ts";

function mapStore(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return { m, keys: () => [...m.keys()], removeItem: (k: string) => void m.delete(k) };
}

const KEPT = {
  "kc:sig:identityKey": "id",
  "kc:sig:session:u2.1": "session",
  "kc:sk:own:g1": "sender-key",
  "kc:e2e-keypair": "kp",
  "kc:homes": "[]",
  theme: "dark",
};

test("logout removes plaintext cache, outbox and drafts and keeps identity and session keys", () => {
  const local = mapStore({
    ...KEPT,
    "kc:draft:c1": "half-written",
    "kc:draft:c2": "another",
    "kc:e2e-pt:m1": "decrypted",
    "kc:e2e-pt-index": '["m1"]',
    "kc:outbox": "[]",
  });
  const vault = mapStore({
    "kc:sig:identityKey": "id",
    "kc:e2e-pt:m2": "decrypted",
    "kc:e2e-pt-index": '["m2"]',
    "kc:outbox": '[{"content":"plaintext"}]',
  });
  clearLocalMessageData([local, vault]);
  assert.deepEqual(Object.fromEntries(local.m), KEPT);
  assert.deepEqual(Object.fromEntries(vault.m), { "kc:sig:identityKey": "id" });
});

test("keys that merely look similar are kept", () => {
  const local = mapStore({ "kc:drafts-seen": "1", "kc:outbox-hint": "1", "kc:e2e-ptx": "1" });
  clearLocalMessageData([local]);
  assert.equal(local.m.size, 3);
});
