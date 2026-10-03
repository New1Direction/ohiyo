// C-M3: the decrypted-message cache stores each entry's expires_at, and reading the cache
// drops entries whose time has passed, including ones nothing will read again (a
// disappearing message that expired while the app was closed), so a disappeared
// message's plaintext doesn't linger on disk.
//   node --experimental-strip-types --test test/e2eCache.test.ts

import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type E2eCache = typeof import("../src/lib/e2eCache.ts");

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
  bundle = await bundleEntry<E2eCache>(join(fixtures, "..", "..", "src", "lib", "e2eCache.ts"), [
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
