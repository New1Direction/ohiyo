// Tests for the Signal multi-device fan-out: every send refreshes each user's device list
// from the directory (no one-time prekeys consumed) and fetches prekey bundles only when
// some device has no session yet — so a steady conversation burns no prekeys, and a
// newly added device still gets its copy on the very next send.
//   node --experimental-strip-types --test test/signalFanout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { fanOut } from "../src/lib/signalFanout.ts";

const PEER = "peer-uuid";
const ME = "me-uuid";
const MY_DEVICE = 7;

type Bundle = { device_id: number; usable?: boolean };

// A fake directory + session store that records every prekey-bundle request.
function world(devices: Record<string, number[]>, sessions: string[] = []) {
  const state = {
    devices,
    sessions: new Set(sessions),
    bundleRequests: [] as string[],
    sessionsStarted: [] as string[],
    directoryDown: false,
    unusable: new Set<string>(),
  };
  const deps = {
    listDevices: async (uid: string) => {
      if (state.directoryDown) throw new Error("directory unavailable");
      return [...(state.devices[uid] ?? [])];
    },
    fetchBundles: async (uid: string): Promise<Bundle[]> => {
      state.bundleRequests.push(uid);
      return (state.devices[uid] ?? []).map((d) => ({ device_id: d }));
    },
    hasSession: async (uid: string, d: number) => state.sessions.has(`${uid}.${d}`),
    startSession: async (uid: string, b: Bundle) => {
      const addr = `${uid}.${b.device_id}`;
      if (state.unusable.has(addr)) return false;
      if (!state.sessions.has(addr)) state.sessionsStarted.push(addr);
      state.sessions.add(addr);
      return true;
    },
    encrypt: async (uid: string, d: number) => ({ t: 1, b: `ct-for-${uid}.${d}` }),
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

test("when the directory can't be read, falls back to fetching bundles", async () => {
  const { state, send } = world({ [PEER]: [1], [ME]: [MY_DEVICE] });
  state.directoryDown = true;
  const r = await send();
  assert.deepEqual(state.bundleRequests, [PEER, ME]);
  assert.deepEqual(Object.keys(r), [`${PEER}.1`]);
});

test("a device whose bundle can't start a session gets no copy", async () => {
  const { state, send } = world({ [PEER]: [1, 2], [ME]: [MY_DEVICE] }, [`${PEER}.1`]);
  state.unusable.add(`${PEER}.2`);
  const r = await send();
  assert.deepEqual(Object.keys(r), [`${PEER}.1`]);
});
