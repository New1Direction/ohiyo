// C-M6 / M5: a full localStorage must not throw into rendering. A write that hits the
// quota evicts the oldest quarter of the decrypted-message cache and retries, repeating
// until the write fits or the cache is empty, and the user is told once per session. The
// encrypted-mode chat list is saved inside React state updaters, so saving it never
// throws; a Signal key write still throws if it can't fit even with the cache gone.
//   node --experimental-strip-types --test test/storageQuota.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { onPlaintextCacheEvicted, saveEncryptedChannels, setItemEvictingPlaintextCache } from "../src/lib/storageQuota.ts";

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
  assert.deepEqual(batches, [["kc:e2e-pt:m1"]]);
  assert.deepEqual(single, ["kc:e2e-pt-index"]); // the emptied cache's index goes too
});

// Eight 10-character entries, m1 oldest, plus their index.
function eightEntries(): Record<string, string> {
  const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
  return { ...Object.fromEntries(ids.map((id) => [`kc:e2e-pt:${id}`, "x".repeat(10)])), "kc:e2e-pt-index": JSON.stringify(ids) };
}
const cacheIds = (s: { m: Map<string, string> }) =>
  [...s.m.keys()].filter((k) => k.startsWith("kc:e2e-pt:")).map((k) => k.slice("kc:e2e-pt:".length));

test("eviction removes the oldest quarter first and stops as soon as the write fits", () => {
  const s = quotaStore(130, eightEntries()); // 80 of entries + 41 of index; the write needs 25
  setItemEvictingPlaintextCache(s, "kc:sig:session:u2.1", "s".repeat(25));
  assert.deepEqual(cacheIds(s), ["m3", "m4", "m5", "m6", "m7", "m8"]);
  assert.deepEqual(JSON.parse(s.m.get("kc:e2e-pt-index")!), ["m3", "m4", "m5", "m6", "m7", "m8"]);
  assert.equal(s.m.get("kc:sig:session:u2.1"), "s".repeat(25));
});

test("eviction keeps taking the oldest quarter until the write fits", () => {
  const s = quotaStore(100, eightEntries());
  setItemEvictingPlaintextCache(s, "kc:sig:session:u2.1", "s".repeat(25));
  assert.deepEqual(cacheIds(s), ["m5", "m6", "m7", "m8"]);
  assert.deepEqual(JSON.parse(s.m.get("kc:e2e-pt-index")!), ["m5", "m6", "m7", "m8"]);
});

test("cache entries the index doesn't list (older builds) go first", () => {
  const s = quotaStore(44, { // 30 of entries + 11 of index; the write needs 4
    "kc:e2e-pt:m2": "x".repeat(10),
    "kc:e2e-pt:m3": "x".repeat(10),
    "kc:e2e-pt:legacy": "x".repeat(10),
    "kc:e2e-pt-index": '["m2","m3"]',
  });
  setItemEvictingPlaintextCache(s, "k", "v".repeat(4));
  assert.deepEqual(cacheIds(s).sort(), ["m2", "m3"]);
});

test("the user is told once per session that older decrypted messages were removed", () => {
  const notices: string[] = [];
  const stop = onPlaintextCacheEvicted((notice) => notices.push(notice));
  try {
    setItemEvictingPlaintextCache(quotaStore(130, eightEntries()), "k", "s".repeat(25));
    setItemEvictingPlaintextCache(quotaStore(130, eightEntries()), "k", "s".repeat(25));
    assert.deepEqual(notices, ["Storage is full. Older decrypted messages were removed from this device."]);
  } finally {
    stop();
  }
});
