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
