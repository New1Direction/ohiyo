// C-H8: a desktop vault that can't be unlocked must stop startup instead of falling back
// to an empty store. The native vault answers every command with "vault_locked: <reason>"
// while locked (src-tauri/src/vault.rs); initVaultBackend must pass that on rather than
// return false, which would make the app run on localStorage with no keys.
//   node --experimental-strip-types --test test/vaultLock.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { vaultLockedReason } from "../src/lib/vaultLock.ts";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type TauriVault = typeof import("../src/lib/tauriVault.ts");
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let bundle: Bundle<TauriVault>;
let invoke: Invoke = () => Promise.reject(new Error("no invoke handler"));

before(async () => {
  const storage = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  // Just enough of a Tauri webview: isDesktop() looks for __TAURI_INTERNALS__, and
  // @tauri-apps/api/core forwards invoke() to it.
  g.window = { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) } };
  g.localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  bundle = await bundleEntry<TauriVault>(join(fixtures, "..", "..", "src", "lib", "tauriVault.ts"), [
    { find: /^\.\/signal$/, replacement: join(fixtures, "signalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

test("vaultLockedReason reads the reason from the native locked error", () => {
  assert.equal(
    vaultLockedReason("vault_locked: the OS keychain could not be read: denied"),
    "the OS keychain could not be read: denied",
  );
  assert.equal(vaultLockedReason(new Error("vault_locked: the sealed vault could not be opened")), "the sealed vault could not be opened");
});

test("other vault errors are not a locked vault", () => {
  for (const err of ["vault_set: disallowed key namespace", new Error("invoke failed"), undefined, null, 42, { message: "vault_locked: x" }]) {
    assert.equal(vaultLockedReason(err), null);
  }
});

test("initVaultBackend rejects with the reason when the native vault is locked", async () => {
  invoke = (cmd) => (cmd === "vault_snapshot" ? Promise.reject("vault_locked: keychain denied") : Promise.resolve(null));
  await assert.rejects(bundle.mod.initVaultBackend(), (err: unknown) => vaultLockedReason(err) === "keychain denied");
});

test("initVaultBackend still falls back to localStorage when the vault is unavailable", async () => {
  invoke = () => Promise.reject(new Error("command vault_snapshot not found"));
  assert.equal(await bundle.mod.initVaultBackend(), false);
});

test("initVaultBackend hydrates from an unlocked vault", async () => {
  invoke = (cmd) => Promise.resolve(cmd === "vault_snapshot" ? { "kc:sig:identityKey": "id" } : null);
  assert.equal(await bundle.mod.initVaultBackend(), true);
  assert.equal(bundle.mod.getVaultStore()?.getItem("kc:sig:identityKey"), "id");
});

test("removing many keys from the vault sends one batch call, not one write per key", async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  invoke = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve(cmd === "vault_snapshot" ? { "kc:e2e-pt:m1": "a", "kc:e2e-pt:m2": "b", "kc:sig:identityKey": "id" } : null);
  };
  await bundle.mod.initVaultBackend();
  calls.length = 0;
  const store = bundle.mod.getVaultStore()!;
  store.removeMany(["kc:e2e-pt:m1", "kc:e2e-pt:m2"]);
  await new Promise((resolve) => setImmediate(resolve)); // the wrapper imports invoke() first
  assert.deepEqual(calls, [{ cmd: "vault_remove_many", args: { keys: ["kc:e2e-pt:m1", "kc:e2e-pt:m2"] } }]);
  assert.deepEqual(store.keys(), ["kc:sig:identityKey"]);
});
