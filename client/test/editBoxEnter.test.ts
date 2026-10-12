// With a mouse and a keyboard, Enter sends (or saves an edit) and Shift+Enter starts a new
// line. On a touch screen the Send button is always there, so Enter starts a new line, as in
// Discord's phone app. Shown here on the edit box; the message box uses the same rule
// (lib/composerKeys.ts, and e2e suite 44 on an emulated phone).
//   node --experimental-strip-types --test test/editBoxEnter.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountEditBox: (el: unknown, value: string) => { calls: string[]; unmount: () => void };
};

const FINE = "(hover: hover) and (pointer: fine)";
let fine = true;
let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === FINE ? fine : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountEditBox.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function mount(pointer: "fine" | "touch") {
  fine = pointer === "fine";
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountEditBox(container, "hello");
  const box = container.querySelector('textarea[aria-label="Edit message"]');
  assert.ok(box, "the edit box is there");
  // What a key press did: the box's own calls, and whether the browser's default (a new line
  // in the text) was stopped.
  const press = (init: { shiftKey?: boolean } = {}) => {
    const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    bundle.mod.act(() => {
      box.dispatchEvent(event);
    });
    return { saved: f.calls.includes("save"), newLineStopped: event.defaultPrevented };
  };
  return {
    press,
    hint: () => (container.textContent ?? "").replace(/\s+/g, " ").trim(),
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("with a mouse, Enter saves the edit", () => {
  const f = mount("fine");
  try {
    assert.deepEqual(f.press(), { saved: true, newLineStopped: true });
  } finally {
    f.done();
  }
});

test("with a mouse, Shift+Enter starts a new line", () => {
  const f = mount("fine");
  try {
    assert.deepEqual(f.press({ shiftKey: true }), { saved: false, newLineStopped: false });
  } finally {
    f.done();
  }
});

test("on a touch screen, Enter starts a new line and doesn't save", () => {
  const f = mount("touch");
  try {
    assert.deepEqual(f.press(), { saved: false, newLineStopped: false });
  } finally {
    f.done();
  }
});

test("on a touch screen the hint names no keys a phone doesn't have", () => {
  const f = mount("touch");
  try {
    const hint = f.hint();
    assert.match(hint, /cancel/);
    assert.match(hint, /save/);
    assert.doesNotMatch(hint, /escape|enter/i);
  } finally {
    f.done();
  }
});
