// C-M6: a full localStorage must not throw into rendering. A write that hits the quota
// evicts the decrypted-message cache and retries once. The encrypted-mode chat list is
// saved inside React state updaters, so saving it never throws; a Signal key write still
// throws if the retry fails too, so a key that couldn't be saved fails its operation.
//   node --experimental-strip-types --test test/storageQuota.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { saveEncryptedChannels, setItemEvictingPlaintextCache } from "../src/lib/storageQuota.ts";

const full = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

/** A store that refuses writes while its values add up to more than `limit` characters. */
function quotaStore(limit: number, entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries));
  const size = () => [...m.values()].reduce((n, v) => n + v.length, 0);
  return {
    m,
    keys: () => [...m.keys()],
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const before = m.get(k);
      m.set(k, v);
      if (size() > limit) {
        if (before === undefined) m.delete(k);
        else m.set(k, before);
        throw full();
      }
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

const CACHE = { "kc:e2e-pt:m1": "x".repeat(80), "kc:e2e-pt-index": '["m1"]' };

test("a full store loses the plaintext cache and the write is retried", () => {
  const s = quotaStore(100, { ...CACHE, "kc:sig:identityKey": "id" });
  setItemEvictingPlaintextCache(s, "kc:sig:session:u2.1", "s".repeat(40));
  assert.deepEqual(Object.fromEntries(s.m), { "kc:sig:identityKey": "id", "kc:sig:session:u2.1": "s".repeat(40) });
});

test("a write that still doesn't fit after eviction throws", () => {
  const s = quotaStore(10, CACHE);
  assert.throws(() => setItemEvictingPlaintextCache(s, "kc:sig:identityKey", "k".repeat(20)), { name: "QuotaExceededError" });
});

test("other storage errors are not treated as a full store", () => {
  const s = { ...quotaStore(100, CACHE), setItem: () => { throw new Error("SecurityError"); } };
  assert.throws(() => setItemEvictingPlaintextCache(s, "k", "v"), /SecurityError/);
  assert.equal(s.m.size, 2);
});

/** Like window.localStorage: items are its own keys, so Object.keys() lists them. */
function storageLike(limit: number, entries: Record<string, string> = {}): Record<string, string> {
  const methods = {
    getItem(this: Record<string, string>, k: string) {
      return Object.hasOwn(this, k) ? this[k] : null;
    },
    setItem(this: Record<string, string>, k: string, v: string) {
      const size = Object.entries(this).reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
      if (size + v.length > limit) throw full();
      this[k] = v;
    },
    removeItem(this: Record<string, string>, k: string) {
      delete this[k];
    },
  };
  return Object.assign(Object.create(methods), entries);
}

test("saving the encrypted-mode chats never throws, and evicts the cache to fit", () => {
  const s = storageLike(90, CACHE); // the cache (86) plus the list (11) doesn't fit
  (globalThis as Record<string, unknown>).localStorage = s;
  saveEncryptedChannels(new Set(["c1", "c2"]));
  assert.deepEqual({ ...s }, { "kc:e2e-channels": '["c1","c2"]' });

  (globalThis as Record<string, unknown>).localStorage = storageLike(5);
  assert.doesNotThrow(() => saveEncryptedChannels(new Set(["c1", "c2"])));
});

test("eviction removes the cache in one batch when the store can batch", () => {
  const s = quotaStore(100, { ...CACHE, "kc:sig:identityKey": "id" });
  const batches: string[][] = [];
  const single: string[] = [];
  const store = {
    ...s,
    removeItem: (k: string) => {
      single.push(k);
      s.removeItem(k);
    },
    removeMany: (keys: string[]) => {
      batches.push(keys);
      for (const k of keys) s.removeItem(k);
    },
  };
  setItemEvictingPlaintextCache(store, "kc:sig:session:u2.1", "s".repeat(40));
  assert.deepEqual(batches, [["kc:e2e-pt:m1", "kc:e2e-pt-index"]]);
  assert.deepEqual(single, []);
});
