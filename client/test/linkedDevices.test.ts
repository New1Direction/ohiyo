// Settings → Linked devices. A list that failed to load read "No devices registered yet",
// which is untrue and hides that something went wrong. And every row's button was just
// "Remove", so a screen reader couldn't tell which device each one removes.
//   node --experimental-strip-types --test test/linkedDevices.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Listed = { device_id: number; updated_at: number };
type Mod = {
  act: (callback: () => void) => void;
  mountLinkedDevices: (el: unknown, list: () => Promise<Listed[]>) => { listCalls: number[]; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountLinkedDevices.tsx"), [
    { find: /^@privacyresearch\/libsignal-protocol-typescript$/, replacement: join(fixtures, "libsignalStub.ts") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const now = () => Math.floor(Date.now() / 1000);

function mount(list: () => Promise<Listed[]>) {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = bundle.mod.mountLinkedDevices(container, list);
  return {
    ...mounted,
    text: () => container.textContent ?? "",
    buttons: (text: string) => [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text),
    cleanup: () => {
      mounted.unmount();
      container.remove();
    },
  };
}

test("a list that fails to load says so, not that there are no devices, and can try again", async () => {
  let failing = true;
  const f = mount(() => (failing ? Promise.reject(new Error("offline")) : Promise.resolve([{ device_id: 7, updated_at: now() }])));
  try {
    await settle();
    assert.match(f.text(), /Couldn.t load your devices/);
    assert.doesNotMatch(f.text(), /No devices registered yet/);

    failing = false;
    const retry = f.buttons("Try again")[0] as unknown as HTMLButtonElement | undefined;
    assert.ok(retry, "there is a Try again button");
    bundle.mod.act(() => retry.click());
    await settle();
    assert.equal(f.listCalls.length, 2, "it asked again");
    assert.match(f.text(), /Device #7/);
  } finally {
    f.cleanup();
  }
});

test("each Remove button names the device it removes", async () => {
  const f = mount(() =>
    Promise.resolve([
      { device_id: 22, updated_at: now() },
      { device_id: 33, updated_at: now() - 7200 },
    ]),
  );
  try {
    await settle();
    const labels = f.buttons("Remove").map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(labels, ["Remove device #22", "Remove device #33"]);
  } finally {
    f.cleanup();
  }
});
