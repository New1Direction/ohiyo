// Tests for the Signal multi-device fan-out: every send refreshes each user's device list
// from the directory (no one-time prekeys consumed) and fetches prekey bundles only when
// some device has no session yet — so a steady conversation burns no prekeys, and a
// newly added device still gets its copy on the very next send. The directory is what
// device warnings and safety numbers come from, so a bundle can never add a reader it
// doesn't list, and without the directory nothing is sent.
//   node --experimental-strip-types --test test/signalFanout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { fanOut } from "../src/lib/signalFanout.ts";

const PEER = "peer-uuid";
const ME = "me-uuid";
const MY_DEVICE = 7;

type Bundle = { device_id: number; identity_key: string };

const keyOf = (uid: string, d: number) => `key-${uid}.${d}`;

// A fake directory + session store that records every prekey-bundle request. The bundle
// endpoint can be made to lie: name extra devices, or give a device another key.
function world(devices: Record<string, number[]>, sessions: string[] = []) {
  const state = {
    devices,
    sessions: new Set(sessions),
    bundleRequests: [] as string[],
    sessionsStarted: [] as string[],
    encrypted: [] as string[],
    directoryDown: false,
    unusable: new Set<string>(),
    extraBundles: {} as Record<string, number[]>,
    bundleKeys: {} as Record<string, string>,
  };
  const deps = {
    listDevices: async (uid: string) => {
      if (state.directoryDown) throw new Error("directory unavailable");
      return (state.devices[uid] ?? []).map((d) => ({ device_id: d, identity_key: keyOf(uid, d) }));
    },
    fetchBundles: async (uid: string): Promise<Bundle[]> => {
      state.bundleRequests.push(uid);
      const ids = [...(state.devices[uid] ?? []), ...(state.extraBundles[uid] ?? [])];
      return ids.map((d) => ({ device_id: d, identity_key: state.bundleKeys[`${uid}.${d}`] ?? keyOf(uid, d) }));
    },
    hasSession: async (uid: string, d: number) => state.sessions.has(`${uid}.${d}`),
    startSession: async (uid: string, b: Bundle) => {
      const addr = `${uid}.${b.device_id}`;
      if (state.unusable.has(addr)) return false;
      if (!state.sessions.has(addr)) state.sessionsStarted.push(addr);
      state.sessions.add(addr);
      return true;
    },
    encrypt: async (uid: string, d: number) => {
      state.encrypted.push(`${uid}.${d}`);
      return { t: 1, b: `ct-for-${uid}.${d}` };
    },
  };
  const send = () => fanOut([PEER, ME], { userId: ME, deviceId: MY_DEVICE }, deps);
  return { state, send };
}

test("a send where every device already has a session makes zero prekey-bundle requests", async () => {
  const { state, send } = world({ [PEER]: [1, 2], [ME]: [MY_DEVICE, 8] }, [`${PEER}.1`, `${PEER}.2`, `${ME}.8`]);
  const r = await send();
  assert.deepEqual(state.bundleRequests, []);
  assert.deepEqual(Object.keys(r).sort(), [`${ME}.8`, `${PEER}.1`, `${PEER}.2`]);
});

test("a device added since the last send gets its copy on the next send", async () => {
  const { state, send } = world({ [PEER]: [1], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  assert.deepEqual(Object.keys(await send()), [`${PEER}.1`]);
  assert.deepEqual(state.bundleRequests, []);

  state.devices[PEER] = [1, 2]; // the peer signs in on a second device
  const r = await send();
  assert.deepEqual(Object.keys(r).sort(), [`${PEER}.1`, `${PEER}.2`]);
  assert.deepEqual(state.bundleRequests, [PEER], "bundles fetched only for the user with a new device");
  assert.deepEqual(state.sessionsStarted, [`${PEER}.2`], "the existing session is reused, not rebuilt");

  await send();
  assert.deepEqual(state.bundleRequests, [PEER], "once every device has a session, no more bundle requests");
});

test("never encrypts to this device, and this device's missing session never triggers a fetch", async () => {
  const { state, send } = world({ [PEER]: [1], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  const r = await send();
  assert.equal(r[`${ME}.${MY_DEVICE}`], undefined);
  assert.deepEqual(state.bundleRequests, []);
});

test("when the directory can't be read, the send fails and nothing is encrypted", async () => {
  const { state, send } = world({ [PEER]: [1], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  state.directoryDown = true;
  await assert.rejects(send());
  assert.deepEqual(state.encrypted, []);
  assert.deepEqual(state.bundleRequests, [], "the bundle list is no stand-in for the directory");
});

test("a device only the bundle endpoint names gets no copy and no session", async () => {
  const { state, send } = world({ [PEER]: [1], [ME]: [MY_DEVICE] });
  state.extraBundles[PEER] = [99]; // a reader the directory doesn't show
  const r = await send();
  assert.deepEqual(Object.keys(r), [`${PEER}.1`]);
  assert.deepEqual(state.sessionsStarted, [`${PEER}.1`]);
});

test("a bundle whose identity key isn't the directory's gets no copy and no session", async () => {
  const { state, send } = world({ [PEER]: [1, 2], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  state.bundleKeys[`${PEER}.2`] = "someone-elses-key";
  const r = await send();
  assert.deepEqual(Object.keys(r), [`${PEER}.1`]);
  assert.deepEqual(state.sessionsStarted, []);
});

test("a device whose bundle can't start a session gets no copy", async () => {
  const { state, send } = world({ [PEER]: [1, 2], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  state.unusable.add(`${PEER}.2`);
  const r = await send();
  assert.deepEqual(Object.keys(r), [`${PEER}.1`]);
});
