// C-M6: this device's Signal key setup. A full store must not stop it: the key write
// evicts the decrypted-message cache and retries once. Two tabs running setup at once
// must not each create an identity and publish keys, so initSignal (and publish, which
// only it calls) runs under a navigator.locks lock. And when the account already has 10
// devices, the server refuses the publish with 403; setup then fails with a message that
// points at the linked-devices list, on first start and on later ones. signal.ts is
// bundled with a stub libsignal (its curve code can't load under node) and a stub fetch.
//   node --experimental-strip-types --test test/signalKeys.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { deviceLimitMessage } from "../src/lib/apiErrors.ts";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Signal = typeof import("../src/lib/signal.ts");

let bundle: Bundle<Signal>;
let published = 0;
let prekeyCount = 100;
let refusePublish = false;

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
    if (url.includes("/signal/keys/count")) return json({ count: prekeyCount });
    if (url.endsWith("/signal/keys") && init?.method === "POST") {
      if (refusePublish) return new Response("too many devices (max 10) — remove one first", { status: 403 });
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
  prekeyCount = 100;
  refusePublish = false;
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

const TOO_MANY_DEVICES =
  "This account already has the maximum of 10 devices. Remove one in Settings → Privacy & security → Linked devices, then reopen Ohiyo.";

test("a new device over the account's device limit fails setup with the linked-devices message", async () => {
  bundle.mod.setSignalBackend(quotaStore(Infinity));
  refusePublish = true;
  await assert.rejects(bundle.mod.initSignal("token"), (err: unknown) => deviceLimitMessage(err) === TOO_MANY_DEVICES);
});

test("a device whose first publish was refused reports the limit again on its next start", async () => {
  const s = quotaStore(Infinity);
  bundle.mod.setSignalBackend(s);
  refusePublish = true;
  await bundle.mod.initSignal("token").catch(() => {}); // first start: identity stored, publish refused
  assert.ok(s.m.has("kc:sig:identityKey"));
  prekeyCount = 0; // nothing of ours on the server, so the next start publishes again
  await assert.rejects(bundle.mod.initSignal("token"), (err: unknown) => deviceLimitMessage(err) === TOO_MANY_DEVICES);
});

test("other failed requests are not the device limit", () => {
  assert.equal(deviceLimitMessage(Object.assign(new Error("offline"), { status: 500 })), null);
  assert.equal(deviceLimitMessage(new Error("Failed to fetch")), null);
});
