// The sign-up form says which characters a username can use before anything is sent, and
// points out the one that can't be used; signing in still takes an older name as it is.
//   node --experimental-strip-types --test test/authScreenUsername.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountAuthScreen: (el: unknown) => { registered: string[]; unmount: () => void };
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
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountAuthScreen.tsx"), [
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

function openDoor() {
  window.localStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = bundle.mod.mountAuthScreen(container);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement;
  const type = (label: string, value: string) =>
    bundle.mod.act(() => {
      const input = container.querySelector(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  return {
    container,
    type,
    signUp: () => bundle.mod.act(() => button("Create an account").click()),
    submit: () => container.querySelector('button[type="submit"]') as unknown as HTMLButtonElement,
    text: () => container.textContent ?? "",
    cleanup: () => {
      mounted.unmount();
      container.remove();
    },
  };
}

test("the sign-up form says which characters a username can use before anything is typed", () => {
  const door = openDoor();
  try {
    door.signUp();
    assert.match(door.text(), /Letters, numbers, dots, dashes and underscores\./);
  } finally {
    door.cleanup();
  }
});

test("a username with a space is pointed out and can't be sent", () => {
  const door = openDoor();
  try {
    door.signUp();
    door.type("Username", "has space");
    door.type("Password", "supersecret123");
    assert.match(door.text(), /No spaces — letters, numbers, dots, dashes and underscores only\./);
    assert.equal(door.submit().disabled, true);
  } finally {
    door.cleanup();
  }
});

test("signing in takes an older name that has other characters", () => {
  const door = openDoor();
  try {
    door.type("Username", "Old Name!");
    door.type("Password", "supersecret123");
    assert.equal(door.submit().disabled, false);
    assert.doesNotMatch(door.text(), /can't go in a username|No spaces/);
  } finally {
    door.cleanup();
  }
});
