// A device added to your account is announced on your other devices (deviceWatch). A
// stolen session could otherwise add a device and read every later encrypted message.
//   node --experimental-strip-types --test test/deviceWatch.test.ts

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  acknowledgeNewDevices,
  deviceAlertAgo,
  forgetDevices,
  newDevices,
  onNewDevicesChange,
  reconcileOwnDevices,
  setDeviceWatchStore,
} from "../src/lib/deviceWatch.ts";

const stored = new Map<string, string>();
setDeviceWatchStore({
  getItem: (k) => stored.get(k) ?? null,
  setItem: (k, v) => void stored.set(k, v),
  removeItem: (k) => void stored.delete(k),
});

const ME = "user-me";
const THIS = 100;
const ids = () => newDevices(ME).map((d) => d.device_id);

beforeEach(() => {
  acknowledgeNewDevices(ME); // also resets the cached snapshot
  stored.clear();
});

test("the first look only records the devices that were already there", () => {
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 7, 8], 1000), []);
  assert.deepEqual(ids(), []);
});

test("a device that appears later is new until you answer", () => {
  reconcileOwnDevices(ME, THIS, [THIS, 7], 1000);
  const found = reconcileOwnDevices(ME, THIS, [THIS, 7, 9], 2000);
  assert.deepEqual(found, [{ device_id: 9, seen_at: 2000 }]);
  // Still new on the next look, with the time it was first seen.
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 7, 9], 3000), [{ device_id: 9, seen_at: 2000 }]);
  acknowledgeNewDevices(ME);
  assert.deepEqual(ids(), []);
  // "It was me" keeps it: it is known now, not new again.
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 7, 9], 4000), []);
});

test("this device is never new to itself, even before its keys are listed", () => {
  reconcileOwnDevices(ME, THIS, [7], 1000);
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 7], 2000), []);
});

test("a device that left the account stops being new", () => {
  reconcileOwnDevices(ME, THIS, [THIS], 1000);
  reconcileOwnDevices(ME, THIS, [THIS, 9], 2000);
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS], 3000), []);
});

test("a removed device that comes back is new again", () => {
  reconcileOwnDevices(ME, THIS, [THIS, 9], 1000); // 9 was already there: known
  forgetDevices(ME, [9]);
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 9], 2000), [{ device_id: 9, seen_at: 2000 }]);
});

test("new devices survive a reload, and only this account sees them", () => {
  reconcileOwnDevices(ME, THIS, [THIS], 1000);
  reconcileOwnDevices(ME, THIS, [THIS, 9], 2000);
  assert.ok([...stored.keys()].some((k) => k.includes(ME)));
  assert.deepEqual(newDevices("someone-else"), []);
  assert.deepEqual(ids(), [9]);
});

test("listeners hear a change, and nothing when nothing changed", () => {
  let calls = 0;
  const off = onNewDevicesChange(() => calls++);
  reconcileOwnDevices(ME, THIS, [THIS], 1000);
  reconcileOwnDevices(ME, THIS, [THIS], 1100);
  assert.equal(calls, 0);
  reconcileOwnDevices(ME, THIS, [THIS, 9], 2000);
  assert.equal(calls, 1);
  // The same snapshot object until it changes (useSyncExternalStore needs that).
  assert.equal(newDevices(ME), newDevices(ME));
  acknowledgeNewDevices(ME);
  assert.equal(calls, 2);
  off();
});

test("a corrupt stored list is treated as no list, not as a crash", () => {
  stored.set(`ohiyo:known-devices:${ME}`, "{not json");
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 9], 1000), []);
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 9, 10], 2000), [{ device_id: 10, seen_at: 2000 }]);
});

// Two tabs of the app share storage but each keeps its own copy in memory. A tab that
// hadn't seen the other's alert used to write its empty copy back over it.
test("a tab that hasn't seen another tab's alert doesn't erase it", () => {
  reconcileOwnDevices(ME, THIS, [THIS], 1000);
  assert.deepEqual(ids(), []); // this tab's copy: nothing new
  // The other tab learns of device 9 and stores it.
  stored.set(`ohiyo:known-devices:${ME}`, JSON.stringify([9, THIS]));
  stored.set(`ohiyo:new-devices:${ME}`, JSON.stringify([{ device_id: 9, seen_at: 2000 }]));
  assert.deepEqual(reconcileOwnDevices(ME, THIS, [THIS, 9], 3000), [{ device_id: 9, seen_at: 2000 }]);
  assert.deepEqual(ids(), [9]);
});

test("a device added while this one was away says when the server last saw it", () => {
  reconcileOwnDevices(ME, THIS, [THIS], 1000);
  const found = reconcileOwnDevices(ME, THIS, [THIS, 9], 9000, new Map([[9, 4000]]));
  assert.deepEqual(found, [{ device_id: 9, seen_at: 4000 }]);
});

test("the alert's time reads naturally", () => {
  const now = 100_000;
  assert.equal(deviceAlertAgo(now - 10, now), "just now");
  assert.equal(deviceAlertAgo(now - 120, now), "2 min ago");
  assert.equal(deviceAlertAgo(now - 3 * 3600, now), "3 h ago");
  assert.equal(deviceAlertAgo(now - 86_400, now), "1 day ago");
  assert.equal(deviceAlertAgo(now - 3 * 86_400, now), "3 days ago");
});
