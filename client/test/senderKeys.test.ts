// Tests for epoch-aware group sender keys (the rekey-on-membership-change core).
// crypto.subtle is global in Node 22; localStorage is not, so we inject an in-memory
// backend and simulate two members by swapping which member's store is active.
//   node --experimental-strip-types --test test/senderKeys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setSenderKeyBackend,
  buildDistribution,
  installDistribution,
  groupEncrypt,
  groupDecrypt,
  getGroupEpoch,
  setGroupEpoch,
} from "../src/lib/senderKeys.ts";

const G = "group-1";
const ALICE = "alice";

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function memStore(): Store {
  const m = new Map<string, string>();
  return { getItem: (k) => (m.has(k) ? (m.get(k) as string) : null), setItem: (k, v) => void m.set(k, v) };
}
const use = (s: Store) => setSenderKeyBackend(s);

// Decode a `grp1.` envelope back to its JSON (test-only introspection).
function envelopeOf(wire: string): { kid: number; it: number; ct: string; sig: string; ep?: number } {
  return JSON.parse(Buffer.from(wire.slice(5), "base64").toString("utf8"));
}

test("round-trips a group message within an epoch", async () => {
  const a = memStore();
  const b = memStore();
  use(a);
  const skdm = await buildDistribution(G);
  use(b);
  installDistribution(G, ALICE, skdm);
  use(a);
  const wire = await groupEncrypt(G, "hello group");
  assert.ok(wire?.startsWith("grp1."));
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, wire!), "hello group");
});

test("a stale member cannot read messages from a newer epoch (rekey closes them out)", async () => {
  const a = memStore();
  const b = memStore();
  // Bootstrap: B installs Alice's epoch-0 key.
  use(a);
  const sk0 = await buildDistribution(G);
  use(b);
  installDistribution(G, ALICE, sk0);

  // Alice rekeys to epoch 1 (a member was removed). B still holds only the epoch-0 key.
  use(a);
  const rotated = await setGroupEpoch(G, 1);
  assert.equal(rotated, true, "advancing past the own-key epoch must rotate");
  const afterRemoval = await groupEncrypt(G, "post-removal secret");
  assert.equal(envelopeOf(afterRemoval!).ep, 1);
  use(b);
  assert.equal(
    await groupDecrypt(G, ALICE, afterRemoval!),
    null,
    "the removed/stale member must NOT decrypt the new epoch",
  );

  // Re-key recovery: Alice redistributes her epoch-1 key, then B can read again.
  use(a);
  const sk1 = await buildDistribution(G);
  assert.equal(JSON.parse(sk1).ep, 1);
  use(b);
  installDistribution(G, ALICE, sk1);
  use(a);
  const ct = await groupEncrypt(G, "after rekey");
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, ct!), "after rekey");
});

test("setGroupEpoch reports rotation only when it advances past the own key", async () => {
  const a = memStore();
  use(a);
  await buildDistribution(G); // own key at epoch 0
  assert.equal(await setGroupEpoch(G, 0), false, "same epoch → no rotation");
  assert.equal(await setGroupEpoch(G, 1), true, "advanced → rotated");
  assert.equal(await setGroupEpoch(G, 1), false, "already at epoch 1 → no rotation");
});

test("getGroupEpoch is monotonic and seeds a joiner's key at the current epoch", async () => {
  const c = memStore();
  use(c);
  assert.equal(getGroupEpoch(G), 0, "defaults to 0");
  assert.equal(await setGroupEpoch(G, 3), false, "no own key yet → nothing to rotate");
  assert.equal(getGroupEpoch(G), 3);
  assert.equal(await setGroupEpoch(G, 2), false, "cannot go backwards");
  assert.equal(getGroupEpoch(G), 3, "monotonic");

  // A member joining at epoch 3 must mint its first sender key tagged epoch 3.
  const skdm = await buildDistribution(G);
  assert.equal(JSON.parse(skdm).ep, 3);
  const wire = await groupEncrypt(G, "joiner message");
  assert.equal(envelopeOf(wire!).ep, 3);
});

test("concurrent groupEncrypt calls never share an iteration (no AES-GCM nonce reuse)", async () => {
  const a = memStore();
  const b = memStore();
  use(a);
  const skdm = await buildDistribution(G);
  use(b);
  installDistribution(G, ALICE, skdm);

  // Two encrypts for the same group, fired concurrently. The per-group serialization must
  // make each ratchet advance atomic — otherwise both encrypt at iteration 0 and reuse the
  // deterministic (AES-256-GCM key, IV) pair, catastrophically breaking confidentiality.
  use(a);
  const [w1, w2] = await Promise.all([groupEncrypt(G, "first"), groupEncrypt(G, "second")]);
  assert.equal(envelopeOf(w1!).it, 0, "first scheduled encrypt takes iteration 0");
  assert.equal(envelopeOf(w2!).it, 1, "second must ratchet to iteration 1, not reuse 0");

  // Both still decrypt for the recipient, in iteration order.
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, w1!), "first");
  assert.equal(await groupDecrypt(G, ALICE, w2!), "second");
});

test("installDistribution ignores a replayed/older-epoch SKDM (no clobber of a newer chain)", async () => {
  const a = memStore();
  const b = memStore();
  // Alice mints epoch-0, then rekeys to epoch-1 and distributes both generations.
  use(a);
  const sk0 = await buildDistribution(G);
  await setGroupEpoch(G, 1);
  const sk1 = await buildDistribution(G);

  // B installs the NEW (epoch-1) key; a stale/replayed epoch-0 SKDM then arrives late.
  use(b);
  installDistribution(G, ALICE, sk1);
  installDistribution(G, ALICE, sk0); // must be ignored, not overwrite the good chain

  // Alice sends at epoch-1; B must still decrypt — proving the replay didn't clobber it.
  use(a);
  const ct = await groupEncrypt(G, "still readable");
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, ct!), "still readable");
});
