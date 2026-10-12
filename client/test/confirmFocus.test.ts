// A confirm step that replaces the button you pressed. Without help, focus falls to the
// page: a keyboard user starts over from the top, and a screen reader reads nothing of the
// question it just asked. Focus goes to what the step says, and back to the button on Cancel.
//   node --experimental-strip-types --test test/confirmFocus.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mounted = { unmount: () => void };
type AlertMod = { act: (callback: () => void) => void; mountNewDeviceAlert: (el: unknown) => Mounted & { answers: string[] } };
type DevicesMod = { act: (callback: () => void) => void; mountLinkedDevices: (el: unknown) => Mounted & { signedOut: string[] } };

let alertBundle: Bundle<AlertMod>;
let devicesBundle: Bundle<DevicesMod>;
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
  const signalStub = [
    { find: /^@privacyresearch\/libsignal-protocol-typescript$/, replacement: join(fixtures, "libsignalStub.ts") },
  ];
  alertBundle = await bundleEntry<AlertMod>(join(fixtures, "mountNewDeviceAlert.tsx"));
  devicesBundle = await bundleEntry<DevicesMod>(join(fixtures, "mountLinkedDevices.tsx"), signalStub);
});

after(async () => {
  await alertBundle?.cleanup();
  await devicesBundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function inContainer<T extends Mounted>(mount: (el: unknown) => T) {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mount(container);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement;
  // What has focus, as text: a failed comparison of two DOM nodes prints their whole
  // object graphs and stalls the run.
  const focused = () => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}: ${el.textContent?.trim()}` : "nothing";
  };
  return {
    ...mounted,
    button,
    focused,
    cleanup: () => {
      mounted.unmount();
      container.remove();
    },
  };
}

test("new-device alert: “Not me” moves focus to what removing does, and Cancel brings it back", () => {
  const f = inContainer(alertBundle.mod.mountNewDeviceAlert);
  try {
    alertBundle.mod.act(() => f.button("Not me").click());
    assert.match(f.focused(), /^p: .*sign you out everywhere/, "focus is on the explanation");
    alertBundle.mod.act(() => f.button("Cancel").click());
    assert.equal(f.focused(), "button: Not me", "focus is back on Not me");
    assert.deepEqual(f.answers, [], "nothing was answered");
  } finally {
    f.cleanup();
  }
});

test("linked devices: “Sign out everywhere…” moves focus to what it does, and Cancel brings it back", () => {
  const f = inContainer(devicesBundle.mod.mountLinkedDevices);
  try {
    devicesBundle.mod.act(() => f.button("Sign out everywhere…").click());
    assert.match(f.focused(), /^span: Every device signed in to your account is signed out/, "focus is on the explanation");
    devicesBundle.mod.act(() => f.button("Cancel").click());
    assert.equal(f.focused(), "button: Sign out everywhere…", "focus is back on the button");
    assert.deepEqual(f.signedOut, [], "nobody was signed out");
  } finally {
    f.cleanup();
  }
});
