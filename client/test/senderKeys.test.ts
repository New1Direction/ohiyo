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
  parseGroupCiphertextHeader,
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
function envelopeOf(wire: string): { kid: number; it: number; ct: string; sig: string; ep?: number; iv?: string } {
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
  const header = parseGroupCiphertextHeader(wire!);
  assert.equal(header?.epoch, 0);
  assert.equal(typeof header?.keyId, "number");
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

test("two sends at the SAME chain iteration (cross-tab race) use different IVs — no nonce reuse", async () => {
  const a = memStore();
  const b = memStore();
  use(a);
  const skdm = await buildDistribution(G);
  use(b);
  installDistribution(G, ALICE, skdm);

  // Simulate two browser tabs/windows that both read iteration 0 of the shared own-key
  // before either persists the ratchet: snapshot the state, encrypt, rewind, encrypt again.
  // Per-context serialization can't prevent this (separate JS contexts); the random IV must.
  use(a);
  const ownStateKey = `kc:sk:own:${G}`;
  const snapshot = a.getItem(ownStateKey)!;
  const w1 = await groupEncrypt(G, "from tab 1");
  a.setItem(ownStateKey, snapshot); // rewind to iteration 0, as a second tab would still see it
  const w2 = await groupEncrypt(G, "from tab 2");

  const e1 = envelopeOf(w1!);
  const e2 = envelopeOf(w2!);
  assert.equal(e1.it, 0);
  assert.equal(e2.it, 0, "both encrypted at the same iteration — the cross-tab race");
  assert.ok(e1.iv && e2.iv, "envelopes must carry a random IV");
  assert.notEqual(e1.iv, e2.iv, "same iteration but DIFFERENT IVs → no AES-GCM nonce reuse");
  // And the message is still authentic + decryptable end-to-end.
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, w1!), "from tab 1");
});

// Re-encode an envelope with some fields replaced (simulates a forged/tampered message).
function forge(wire: string, patch: Record<string, unknown>): string {
  const env = { ...envelopeOf(wire), ...patch };
  return `grp1.${Buffer.from(JSON.stringify(env), "utf8").toString("base64")}`;
}

// Bootstrap: B holds Alice's sender key; returns both stores.
async function pair(): Promise<{ a: Store; b: Store }> {
  const a = memStore();
  const b = memStore();
  use(a);
  const skdm = await buildDistribution(G);
  use(b);
  installDistribution(G, ALICE, skdm);
  return { a, b };
}

// Count HMAC signs (each chain-ratchet step is one) while `fn` runs.
async function countHmacs(fn: () => Promise<unknown>): Promise<number> {
  const subtle = crypto.subtle as SubtleCrypto & { sign: SubtleCrypto["sign"] };
  const orig = subtle.sign;
  let n = 0;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
    if ((typeof alg === "string" ? alg : alg.name) === "HMAC") n++;
    return orig.call(subtle, alg, key, data);
  }) as SubtleCrypto["sign"];
  try {
    await fn();
  } finally {
    subtle.sign = orig;
  }
  return n;
}

test("a huge sender-supplied iteration (it = 4e9) is refused in under 100 ms", async () => {
  const { a, b } = await pair();
  use(a);
  const wire = await groupEncrypt(G, "hello");
  use(b);
  const started = performance.now();
  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    groupDecrypt(G, ALICE, forge(wire!, { it: 4e9 })),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(timedOut), 100)),
  ]);
  assert.notEqual(result, timedOut, "groupDecrypt must not ratchet billions of steps");
  assert.equal(result, null);
  assert.ok(performance.now() - started < 100);
});

test("an iteration more than 2000 steps ahead of the stored chain is refused without ratcheting", async () => {
  const { a, b } = await pair();
  use(a);
  const wire = await groupEncrypt(G, "hello");
  use(b);
  const hmacs = await countHmacs(async () => {
    assert.equal(await groupDecrypt(G, ALICE, forge(wire!, { it: 2001 })), null);
  });
  assert.equal(hmacs, 0, "no ratchet step may run past the 2000-step cap");
  // A genuine message a few steps ahead still decrypts.
  use(a);
  for (let i = 0; i < 4; i++) await groupEncrypt(G, `skipped ${i}`);
  const ahead = await groupEncrypt(G, "five ahead");
  use(b);
  assert.equal(await groupDecrypt(G, ALICE, ahead!), "five ahead");
});

test("the signature is verified before any ratchet work", async () => {
  const { a, b } = await pair();
  use(a);
  const first = await groupEncrypt(G, "first");
  const second = await groupEncrypt(G, "second");
  use(b);
  // `first`'s ciphertext with `second`'s signature: well-formed but not authentic.
  const tampered = forge(first!, { sig: envelopeOf(second!).sig, it: 5 });
  const hmacs = await countHmacs(async () => {
    assert.equal(await groupDecrypt(G, ALICE, tampered), null);
  });
  assert.equal(hmacs, 0, "a bad signature must be rejected before ratcheting the chain");
});

test("a bad signature does not advance the stored chain", async () => {
  const { a, b } = await pair();
  use(a);
  const first = await groupEncrypt(G, "first");
  const second = await groupEncrypt(G, "second");
  use(b);
  const peerStateKey = `kc:sk:peer:${G}:${ALICE}`;
  const before = b.getItem(peerStateKey);
  assert.equal(await groupDecrypt(G, ALICE, forge(second!, { sig: envelopeOf(first!).sig })), null);
  assert.equal(b.getItem(peerStateKey), before, "stored state must be untouched");
  // The genuine messages still decrypt in order.
  assert.equal(await groupDecrypt(G, ALICE, first!), "first");
  assert.equal(await groupDecrypt(G, ALICE, second!), "second");
});

test("a non-integer or negative iteration is rejected", async () => {
  const { a, b } = await pair();
  use(a);
  await groupEncrypt(G, "iteration 0");
  const atOne = await groupEncrypt(G, "iteration 1");
  use(b);
  const peerStateKey = `kc:sk:peer:${G}:${ALICE}`;
  const before = b.getItem(peerStateKey);
  // 0.5 would ratchet one step and decrypt iteration 1's message, then store iteration 1.5.
  assert.equal(await groupDecrypt(G, ALICE, forge(atOne!, { it: 0.5 })), null);
  assert.equal(await groupDecrypt(G, ALICE, forge(atOne!, { it: -1 })), null);
  assert.equal(await groupDecrypt(G, ALICE, forge(atOne!, { it: "1" })), null);
  assert.equal(b.getItem(peerStateKey), before, "stored state must be untouched");
  assert.equal(await groupDecrypt(G, ALICE, atOne!), "iteration 1");
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
