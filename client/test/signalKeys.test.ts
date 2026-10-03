// C-M6: this device's Signal key setup. A full store must not stop it: the key write
// evicts the decrypted-message cache and retries once. Two tabs running setup at once
// must not each create an identity and publish keys, so initSignal (and publish, which
// only it calls) runs under a navigator.locks lock. signal.ts is bundled with a stub
// libsignal (its curve code can't load under node) and a stub fetch (no network).
//   node --experimental-strip-types --test test/signalKeys.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Signal = typeof import("../src/lib/signal.ts");

let bundle: Bundle<Signal>;
let published = 0;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// A store that refuses writes while its values add up to more than `limit` characters.
function quotaStore(limit: number, entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries));
  const size = () => [...m.values()].reduce((n, v) => n + v.length, 0);
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const before = m.get(k);
      m.set(k, v);
      if (size() <= limit) return;
      if (before === undefined) m.delete(k);
      else m.set(k, before);
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

// navigator.locks with one queue per lock name, like the browser's exclusive mode.
function installLocks(): void {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, cb: () => Promise<unknown>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
}

before(async () => {
  const g = globalThis as Record<string, unknown>;
  const empty = { getItem: () => null, setItem() {}, removeItem() {} };
  g.localStorage = empty;
  g.fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/users/@me")) return json({ id: "11111111-2222-4333-8444-555555555555" });
    if (url.includes("/signal/keys/count")) return json({ count: 100 });
    if (url.endsWith("/signal/keys") && init?.method === "POST") {
      published++;
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  installLocks();
  bundle = await bundleEntry<Signal>(join(fixtures, "..", "..", "src", "lib", "signal.ts"), [
    { find: /^@privacyresearch\/libsignal-protocol-typescript$/, replacement: join(fixtures, "libsignalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

beforeEach(() => {
  published = 0;
});

test("key setup on a full store evicts the plaintext cache instead of failing", async () => {
  const cache = { "kc:e2e-pt:m1": "x".repeat(40_000), "kc:e2e-pt-index": '["m1"]' };
  const s = quotaStore(45_000, cache);
  bundle.mod.setSignalBackend(s);
  await bundle.mod.initSignal("token");
  assert.ok(s.m.has("kc:sig:identityKey"), "identity stored");
  assert.equal(s.m.has("kc:e2e-pt:m1"), false);
  assert.equal(published, 1);
});

test("two key setups at once create and publish one identity", async () => {
  const s = quotaStore(Infinity);
  bundle.mod.setSignalBackend(s);
  await Promise.all([bundle.mod.initSignal("token"), bundle.mod.initSignal("token")]);
  assert.equal(published, 1);
});
