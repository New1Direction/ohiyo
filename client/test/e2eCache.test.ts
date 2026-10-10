// C-M3: the decrypted-message cache stores each entry's expires_at, and reading the cache
// drops entries whose time has passed, including ones nothing will read again (a
// disappearing message that expired while the app was closed), so a disappeared
// message's plaintext doesn't linger on disk. On desktop the sweep removes expired
// entries from the vault in one batch write, not one write per entry.
//   node --experimental-strip-types --test test/e2eCache.test.ts

import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type E2eCache = typeof import("../src/lib/e2eCache.ts") & Pick<typeof import("../src/lib/tauriVault.ts"), "initVaultBackend">;

const T0 = 1_800_000_000; // unix seconds
const INDEX = "kc:e2e-pt-index";
const stored = new Map<string, string>();
let bundle: Bundle<E2eCache>;

before(async () => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
    get length() {
      return stored.size;
    },
    key: (i: number) => [...stored.keys()][i] ?? null,
  };
  bundle = await bundleEntry<E2eCache>(join(fixtures, "vaultCache.ts"), [
    { find: /^\.\/signal$/, replacement: join(fixtures, "signalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

beforeEach(() => {
  stored.clear();
  mock.timers.enable({ apis: ["Date"], now: T0 * 1000 });
});

afterEach(() => mock.timers.reset());

const index = () => JSON.parse(stored.get(INDEX) ?? "[]") as string[];

test("an entry is readable until its expires_at, then dropped from storage", () => {
  const { cachePlaintext, getCachedPlaintext } = bundle.mod;
  cachePlaintext("m1", "secret", T0 + 60);
  assert.equal(getCachedPlaintext("m1"), "secret");
  mock.timers.setTime((T0 + 60) * 1000);
  assert.equal(getCachedPlaintext("m1"), null);
  assert.equal(stored.has("kc:e2e-pt:m1"), false);
  assert.deepEqual(index(), []);
});

test("reading the cache also drops other expired entries", () => {
  const { cachePlaintext, getCachedPlaintext } = bundle.mod;
  cachePlaintext("m1", "disappears", T0 + 10);
  cachePlaintext("m2", "stays", null);
  mock.timers.setTime((T0 + 11) * 1000);
  assert.equal(getCachedPlaintext("m2"), "stays");
  assert.equal(stored.has("kc:e2e-pt:m1"), false);
  assert.deepEqual(index(), ["m2"]);
});

test("entries without an expiry, and bare entries from before expiries were stored, stay readable", () => {
  const { cachePlaintext, getCachedPlaintext } = bundle.mod;
  cachePlaintext("m3", '{"pt":"looks like json","expires_at":1}', null);
  stored.set("kc:e2e-pt:legacy", "older plaintext");
  stored.set(INDEX, JSON.stringify([...index(), "legacy"]));
  mock.timers.setTime((T0 + 10 * 365 * 86400) * 1000);
  assert.equal(getCachedPlaintext("m3"), '{"pt":"looks like json","expires_at":1}');
  assert.equal(getCachedPlaintext("legacy"), "older plaintext");
  assert.deepEqual(index(), ["m3", "legacy"]);
});

// A restore from an older recovery backup writes plaintext entries straight to the store
// (tauriVault importKeyMaterial), so they are missing from the index. Without the sign-in
// sweep, a restored disappearing message nobody opens stays on disk past its expiry.
const restored = (id: string, pt: string, expiresAt: number | null) =>
  stored.set("kc:e2e-pt:" + id, JSON.stringify({ pt, expires_at: expiresAt }));

test("the sign-in sweep drops restored entries that have already expired, unread", () => {
  const { cachePlaintext, sweepPlaintextCache } = bundle.mod;
  cachePlaintext("live", "kept", null);
  restored("gone", "already disappeared", T0 - 1);
  sweepPlaintextCache();
  assert.equal(stored.has("kc:e2e-pt:gone"), false);
  assert.equal(stored.get("kc:e2e-pt:live"), JSON.stringify({ pt: "kept", expires_at: null }));
});

test("restored entries that are still live join the index, so they expire on time", () => {
  const { cachePlaintext, getCachedPlaintext, sweepPlaintextCache } = bundle.mod;
  cachePlaintext("live", "kept", null);
  restored("soon", "disappears later", T0 + 60);
  stored.set("kc:e2e-pt:bare", "plaintext from before expiries were stored");
  sweepPlaintextCache();
  // Restored entries go to the old end of the index: first out when the cache is full.
  assert.deepEqual(index(), ["soon", "bare", "live"]);
  assert.equal(getCachedPlaintext("soon"), "disappears later");
  mock.timers.setTime((T0 + 61) * 1000);
  assert.equal(getCachedPlaintext("live"), "kept"); // reading anything sweeps
  assert.equal(stored.has("kc:e2e-pt:soon"), false);
  assert.equal(getCachedPlaintext("bare"), "plaintext from before expiries were stored");
  assert.deepEqual(index(), ["bare", "live"]);
});

test("folding restored entries in keeps the cache within its bound", () => {
  const { sweepPlaintextCache } = bundle.mod;
  const ids = Array.from({ length: 4999 }, (_, i) => `m${i}`);
  for (const id of ids) stored.set("kc:e2e-pt:" + id, JSON.stringify({ pt: id, expires_at: null }));
  stored.set(INDEX, JSON.stringify(ids));
  restored("r1", "one", null);
  restored("r2", "two", null);
  restored("r3", "three", null);
  sweepPlaintextCache();
  const idx = index();
  assert.equal(idx.length, 5000);
  assert.deepEqual(idx.slice(0, 2), ["r3", "m0"]);
  assert.equal(stored.has("kc:e2e-pt:r1"), false);
  assert.equal(stored.has("kc:e2e-pt:r2"), false);
});

test("the sign-in sweep also drops indexed entries that expired while nothing read the cache", () => {
  const { cachePlaintext, sweepPlaintextCache } = bundle.mod;
  cachePlaintext("m1", "disappears", T0 + 10);
  mock.timers.setTime((T0 + 11) * 1000);
  sweepPlaintextCache();
  assert.equal(stored.has("kc:e2e-pt:m1"), false);
  assert.deepEqual(index(), []);
});

// Runs last: once the vault backend is on, the cache stays on it for the rest of the file.
test("on desktop the sweep removes expired entries from the vault in one batch", async () => {
  const calls: string[] = [];
  const removed: unknown[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: { keys?: unknown }) => {
        calls.push(cmd);
        if (cmd === "vault_remove_many") removed.push(args?.keys);
        return Promise.resolve(cmd === "vault_snapshot" ? {} : null);
      },
    },
  };
  const { cachePlaintext, getCachedPlaintext, initVaultBackend } = bundle.mod;
  assert.equal(await initVaultBackend(), true);
  cachePlaintext("m1", "one", T0 + 10);
  cachePlaintext("m2", "two", T0 + 10);
  cachePlaintext("m3", "stays", null);
  mock.timers.setTime((T0 + 11) * 1000);
  calls.length = 0;
  assert.equal(getCachedPlaintext("m3"), "stays");
  await new Promise((resolve) => setImmediate(resolve)); // the vault wrapper imports invoke() first
  assert.deepEqual(removed, [["kc:e2e-pt:m1", "kc:e2e-pt:m2"]]);
  assert.deepEqual(calls.filter((c) => c === "vault_remove"), []);
});
