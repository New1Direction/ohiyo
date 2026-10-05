// The one module that talks to the desktop shell. In a browser every call does nothing
// and never throws; in the desktop app each one invokes the command the shell expects.
//   node --experimental-strip-types --test test/desktopShell.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Prefs = { keep_running: boolean; tray_hint_shown: boolean };
type Mod = {
  setUnreadBadge: (count: number) => Promise<void>;
  setInCall: (inCall: boolean) => Promise<void>;
  getDesktopPrefs: () => Promise<Prefs | null>;
  setKeepRunning: (on: boolean) => Promise<Prefs | null>;
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (on: boolean) => Promise<boolean>;
};
let bundle: Bundle<Mod>;
const g = globalThis as Record<string, unknown>;
let calls: Array<[string, unknown]> = [];
let answer: (cmd: string, args: unknown) => unknown = () => null;

function asDesktop(): void {
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown) => {
        calls.push([cmd, args]);
        return answer(cmd, args);
      },
    },
  };
}

before(async () => {
  g.window = {};
  bundle = await bundleEntry<Mod>(join(fixtures, "desktopShellEntry.ts"));
});
beforeEach(() => {
  calls = [];
  answer = () => null;
  g.window = {};
});
after(async () => {
  await bundle?.cleanup();
});

test("in a browser nothing is invoked and nothing throws", async () => {
  await bundle.mod.setUnreadBadge(3);
  await bundle.mod.setInCall(true);
  assert.equal(await bundle.mod.getDesktopPrefs(), null);
  assert.equal(await bundle.mod.setKeepRunning(true), null);
  assert.equal(await bundle.mod.getOpenAtLogin(), false);
  assert.equal(await bundle.mod.setOpenAtLogin(true), false);
  assert.deepEqual(calls, []);
});

test("in the desktop app the unread total and call state reach the shell", async () => {
  asDesktop();
  await bundle.mod.setUnreadBadge(4);
  await bundle.mod.setInCall(true);
  assert.deepEqual(calls, [["desktop_set_unread", { count: 4 }], ["desktop_set_in_call", { inCall: true }]]);
});

test("the badge is always a whole number of at least zero", async () => {
  asDesktop();
  for (const odd of [-2, 2.9, Number.NaN, Number.POSITIVE_INFINITY]) await bundle.mod.setUnreadBadge(odd);
  assert.deepEqual(calls.map(([, args]) => (args as { count: number }).count), [0, 2, 0, 0]);
});

test("prefs and open-at-login round trip through the shell", async () => {
  asDesktop();
  answer = (cmd, args) => {
    if (cmd === "desktop_prefs_get") return { keep_running: true, tray_hint_shown: false };
    if (cmd === "desktop_prefs_set") return { keep_running: (args as { keepRunning: boolean }).keepRunning, tray_hint_shown: false };
    if (cmd === "desktop_autostart_get") return true;
    if (cmd === "desktop_autostart_set") return (args as { enabled: boolean }).enabled;
    return null;
  };
  assert.deepEqual(await bundle.mod.getDesktopPrefs(), { keep_running: true, tray_hint_shown: false });
  assert.deepEqual(await bundle.mod.setKeepRunning(false), { keep_running: false, tray_hint_shown: false });
  assert.equal(await bundle.mod.getOpenAtLogin(), true);
  assert.equal(await bundle.mod.setOpenAtLogin(false), false);
});

test("a shell that fails does not break the app", async () => {
  asDesktop();
  answer = () => {
    throw new Error("command not found");
  };
  await bundle.mod.setUnreadBadge(1);
  assert.equal(await bundle.mod.getDesktopPrefs(), null);
  assert.equal(await bundle.mod.getOpenAtLogin(), false);
});
