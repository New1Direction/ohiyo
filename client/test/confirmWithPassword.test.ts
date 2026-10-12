// The step that asks for the password again before an action a stolen session must not
// take on its own (replacing or deleting the recovery backup, the dead-man's switch).
//   node --experimental-strip-types --test test/confirmWithPassword.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountConfirmWithPassword: (el: unknown) => { confirmed: string[]; cancelled: () => number; unmount: () => void };
};

let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  const globals = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountConfirmWithPassword.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const m = bundle.mod.mountConfirmWithPassword(container);
  const form = container.querySelector('form[aria-label="Confirm with your password"]')!;
  const input = container.querySelector('input[aria-label="Your password"]') as unknown as HTMLInputElement;
  const submit = form.querySelector('button[type="submit"]') as unknown as HTMLButtonElement;
  const type = (value: string) =>
    bundle.mod.act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  return { ...m, container, form, input, submit, type, cleanup: () => (m.unmount(), container.remove()) };
}

test("it asks for the current password, ready to type", () => {
  const f = mount();
  try {
    assert.equal(f.input.getAttribute("type"), "password");
    assert.equal(f.input.getAttribute("autocomplete"), "current-password");
    assert.equal(document.activeElement, f.input, "the field has focus");
    assert.equal(f.submit.textContent?.trim(), "Back up my keys");
  } finally {
    f.cleanup();
  }
});

test("confirming hands over the password; an empty field can't confirm", () => {
  const f = mount();
  try {
    assert.equal(f.submit.disabled, true);
    f.type("hunter22");
    assert.equal(f.submit.disabled, false);
    bundle.mod.act(() => f.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(f.confirmed, ["hunter22"]);
  } finally {
    f.cleanup();
  }
});

test("cancel backs out without confirming", () => {
  const f = mount();
  try {
    f.type("hunter22");
    const cancel = [...f.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel")!;
    bundle.mod.act(() => (cancel as unknown as HTMLButtonElement).click());
    assert.equal(f.cancelled(), 1);
    assert.deepEqual(f.confirmed, []);
  } finally {
    f.cleanup();
  }
});
