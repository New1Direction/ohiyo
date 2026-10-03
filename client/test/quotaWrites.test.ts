// M5: writes that used to throw on a full localStorage. The sender-key store's writes free
// space the same way the Signal store's do (oldest decrypted-message cache entries first),
// and saving the homes list never throws, since it can run while rendering.
//   node --experimental-strip-types --test test/quotaWrites.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDistribution } from "../src/lib/senderKeys.ts";
import { saveHomes } from "../src/lib/homes.ts";

/** Like window.localStorage (items are own keys), refusing writes past `limit` characters. */
function storageLike(limit: number, entries: Record<string, string> = {}): Record<string, string> {
  const methods = {
    getItem(this: Record<string, string>, k: string) {
      return Object.hasOwn(this, k) ? this[k] : null;
    },
    setItem(this: Record<string, string>, k: string, v: string) {
      const size = Object.entries(this).reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
      if (size + v.length > limit) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      this[k] = v;
    },
    removeItem(this: Record<string, string>, k: string) {
      delete this[k];
    },
  };
  return Object.assign(Object.create(methods), entries);
}

const cache = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  return { ...Object.fromEntries(ids.map((id) => [`kc:e2e-pt:${id}`, "x".repeat(200)])), "kc:e2e-pt-index": JSON.stringify(ids) };
};
const g = globalThis as Record<string, unknown>;

test("a sender-key write on a full store frees space instead of failing", async () => {
  const s = storageLike(2000, cache(8)); // 1600 of cache: no room for a new sender key
  g.localStorage = s;
  await buildDistribution("g1");
  assert.ok(Object.keys(s).some((k) => k.startsWith("kc:sk:own:")), "own sender key stored");
  assert.ok(Object.keys(s).filter((k) => k.startsWith("kc:e2e-pt:")).length < 8, "some cache evicted");
});

test("saving the homes list on a full store frees space and doesn't throw", () => {
  const s = storageLike(1650, cache(8));
  g.localStorage = s;
  saveHomes([{ id: "h1", name: "Home", url: "https://home.example", token: null }]);
  assert.ok(s["kc:homes:v1"], "homes saved");
});

test("saving the homes list never throws, even when it can't be saved at all", () => {
  g.localStorage = storageLike(10);
  assert.doesNotThrow(() => saveHomes([{ id: "h1", name: "Home", url: "https://home.example", token: null }]));
});
