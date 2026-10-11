// Restoring a key backup made on another device turns this device into that device: its
// Signal id, identity and sessions. Before, the backup was merged into this device's own
// Signal state, so (1) the id this device signed in with stayed in the account with keys
// nobody holds, and senders kept encrypting copies to it, and (2) a session this device
// had opened was then used under the backup's identity, which the other side can't read.
//   node --experimental-strip-types --test test/restoreDevice.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
import { retireDevice, retryRetiredDevice } from "../src/lib/retiredDevice.ts";

type Vault = typeof import("../src/lib/tauriVault.ts");

const stored = new Map<string, string>();
let bundle: Bundle<Pick<Vault, "importKeyMaterial" | "initVaultBackend">>;

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
  bundle = await bundleEntry(join(fixtures, "vaultRestore.ts"), [
    { find: /^\.\/signal$/, replacement: join(fixtures, "signalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
});

beforeEach(() => stored.clear());

const PEER = "peer-user";
// This device (device 2) after signing in: its own Signal keys, a session it opened, and
// what it knows about the peer.
function signedInDevice2(): Map<string, string> {
  return new Map([
    ["kc:sig:deviceId", "2222"],
    ["kc:sig:identityKey", "identity-2"],
    ["kc:sig:registrationId", "reg-2"],
    ["kc:sig:nextPreKeyId", "101"],
    ["kc:sig:prekey150", "otk-2"],
    ["kc:sig:signedprekey777", "spk-2"],
    [`kc:sig:session${PEER}.9`, "session-2-with-peer"],
    [`kc:sig:session${PEER}.8`, "session-2-with-other-peer-device"],
    [`kc:sig:identity${PEER}.9`, "peer-identity"],
    [`kc:sig:verified:${PEER}`, "verified"],
    ["kc:sig:ownUserId", "me"],
    ["kc:sk:own:group-1", "sender-key-2"],
    ["kc:e2e-pt:m1", "cached plaintext"],
    ["theme", "dusk"],
  ]);
}

// A backup made on device 1.
const fromDevice1: Record<string, string> = {
  "kc:sig:deviceId": "1111",
  "kc:sig:identityKey": "identity-1",
  "kc:sig:registrationId": "reg-1",
  "kc:sig:nextPreKeyId": "51",
  "kc:sig:prekey3": "otk-1",
  [`kc:sig:session${PEER}.9`]: "session-1-with-peer",
  [`kc:sig:identity${PEER}.9`]: "peer-identity",
  "kc:sig:ownUserId": "me",
  "kc:sk:own:group-1": "sender-key-1",
};

test("a backup from another device replaces this device's own Signal state, and names the id it replaced", async () => {
  for (const [k, v] of signedInDevice2()) stored.set(k, v);
  const { replacedDevice } = await bundle.mod.importKeyMaterial(fromDevice1);
  assert.equal(replacedDevice, 2222);
  // Now device 1: its id, identity, prekeys and sessions.
  assert.equal(stored.get("kc:sig:deviceId"), "1111");
  assert.equal(stored.get("kc:sig:identityKey"), "identity-1");
  assert.equal(stored.get("kc:sig:nextPreKeyId"), "51");
  assert.equal(stored.get(`kc:sig:session${PEER}.9`), "session-1-with-peer");
  // Nothing of device 2's own Signal state is left to mix with it.
  for (const gone of ["kc:sig:prekey150", "kc:sig:signedprekey777", `kc:sig:session${PEER}.8`]) {
    assert.equal(stored.has(gone), false, gone);
  }
  // What it knew about other people stays, and so does everything outside Signal.
  assert.equal(stored.get(`kc:sig:verified:${PEER}`), "verified");
  assert.equal(stored.get(`kc:sig:identity${PEER}.9`), "peer-identity");
  assert.equal(stored.get("kc:e2e-pt:m1"), "cached plaintext");
  assert.equal(stored.get("theme"), "dusk");
  assert.equal(stored.get("kc:sk:own:group-1"), "sender-key-1");
});

test("a backup made on this same device merges in and replaces nothing", async () => {
  for (const [k, v] of signedInDevice2()) stored.set(k, v);
  const sameDevice = { ...fromDevice1, "kc:sig:deviceId": "2222", "kc:sig:identityKey": "identity-2" };
  const { replacedDevice } = await bundle.mod.importKeyMaterial(sameDevice);
  assert.equal(replacedDevice, null);
  // A session opened after that backup is kept.
  assert.equal(stored.get(`kc:sig:session${PEER}.8`), "session-2-with-other-peer-device");
  assert.equal(stored.get("kc:sig:signedprekey777"), "spk-2");
});

test("a backup with no Signal identity does not swap the device", async () => {
  for (const [k, v] of signedInDevice2()) stored.set(k, v);
  const noIdentity = { "kc:sk:own:group-1": "sender-key-1", "kc:sig:deviceId": "1111" };
  const { replacedDevice } = await bundle.mod.importKeyMaterial(noIdentity);
  assert.equal(replacedDevice, null);
  assert.equal(stored.get("kc:sig:signedprekey777"), "spk-2");
});

test("the replaced id is removed from the account; if that fails, the next start finishes it", async () => {
  const removed: number[] = [];
  const ok = async (id: number) => void removed.push(id);
  const down = async () => {
    throw new Error("offline");
  };
  assert.equal(await retireDevice(ok, "me", 2222), true);
  assert.deepEqual(removed, [2222]);
  assert.equal(stored.has("ohiyo:retired-signal-device"), false);

  assert.equal(await retireDevice(down, "me", 3333), false);
  await retryRetiredDevice(down, "me", () => 1111); // still failing: kept
  await retryRetiredDevice(ok, "someone-else", () => 1111); // another account: untouched
  assert.deepEqual(removed, [2222]);
  await retryRetiredDevice(ok, "me", () => 1111);
  assert.deepEqual(removed, [2222, 3333]);
  assert.equal(stored.has("ohiyo:retired-signal-device"), false);
});

test("the device in use is never removed", async () => {
  const removed: number[] = [];
  await retireDevice(async () => {
    throw new Error("offline");
  }, "me", 1111);
  await retryRetiredDevice(async (id) => void removed.push(id), "me", () => 1111);
  assert.deepEqual(removed, []);
  assert.equal(stored.has("ohiyo:retired-signal-device"), false);
});

// Runs last: once the vault backend is on, it stays on for the rest of the file.
test("on desktop the replaced device's keys leave the vault in one write", async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return Promise.resolve(cmd === "vault_snapshot" ? Object.fromEntries(signedInDevice2()) : null);
      },
    },
  };
  assert.equal(await bundle.mod.initVaultBackend(), true);
  calls.length = 0;
  const { replacedDevice } = await bundle.mod.importKeyMaterial(fromDevice1);
  assert.equal(replacedDevice, 2222);
  const removals = calls.filter((c) => c.cmd === "vault_remove_many" || c.cmd === "vault_remove");
  assert.equal(removals.length, 1);
  assert.deepEqual(
    [...(removals[0].args?.keys as string[])].sort(),
    [
      "kc:sig:deviceId",
      "kc:sig:identityKey",
      "kc:sig:nextPreKeyId",
      "kc:sig:prekey150",
      `kc:sig:session${PEER}.8`,
      `kc:sig:session${PEER}.9`,
      "kc:sig:registrationId",
      "kc:sig:signedprekey777",
    ].sort(),
  );
  const sets = calls.filter((c) => c.cmd === "vault_set").map((c) => c.args?.key);
  assert.ok(sets.includes("kc:sig:deviceId") && sets.includes("kc:sig:identityKey"));
});
