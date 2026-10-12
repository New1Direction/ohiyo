// The tray and the dock outlive the signed-in app. After a sign-out they must not keep the
// last account's unread count or offer to leave a call, and the tray's "Check for updates"
// must still answer on the sign-in screen.
//   node --experimental-strip-types --test test/desktopShellSignOut.test.ts

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mounted = { unmount: () => void };
type Mod = {
  act: (callback: () => void) => void;
  shellCalls: Array<[string, unknown]>;
  fireShellEvent: (name: string, payload?: unknown) => number;
  mountSignedInShell: (el: unknown, unread: number, inCall: boolean) => Mounted;
  mountSignedOutUpdates: (el: unknown) => Mounted;
};

let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  const globals = {
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountDesktopShell.tsx"), [
    { find: /^\.\.\/lib\/desktopShell$/, replacement: join(fixtures, "desktopShellStub.ts") },
  ]);
});

beforeEach(() => {
  bundle.mod.shellCalls.length = 0;
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function container() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

const last = (kind: string) => bundle.mod.shellCalls.filter(([k]) => k === kind).at(-1)?.[1];

test("signing out clears the dock badge and the tray's unread count and Leave call", () => {
  const el = container();
  const shell = bundle.mod.mountSignedInShell(el, 3, true);
  assert.equal(last("unread"), 3);
  assert.equal(last("inCall"), true);
  shell.unmount(); // the signed-in app goes away on sign-out (and on switching homes)
  assert.equal(last("unread"), 0, "the dock badge and tray tooltip go back to no unread");
  assert.equal(last("inCall"), false, "the tray stops offering Leave call");
  el.remove();
});

test("the tray's Check for updates answers on the sign-in screen", async () => {
  const el = container();
  const signedOut = bundle.mod.mountSignedOutUpdates(el);
  await new Promise((resolve) => setTimeout(resolve, 0)); // the listener is set up asynchronously
  const heard = bundle.mod.fireShellEvent("check-updates");
  assert.equal(heard, 1, "something on the sign-in screen listens for the tray's choice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Test bundles are not release builds, so the answer is that this copy doesn't update itself.
  assert.match(document.body.textContent ?? "", /doesn't update itself/);
  signedOut.unmount();
  assert.equal(bundle.mod.fireShellEvent("check-updates"), 0, "and stops listening once someone signs in");
  el.remove();
});
