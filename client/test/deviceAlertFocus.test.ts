// The new-device alert asks a security question. It used to sit above Settings on screen
// while Settings kept the keyboard: Tab cycled inside Settings and never reached the alert,
// and Escape closed Settings. The alert is now a modal alertdialog that takes focus, keeps
// Tab inside itself, and gives focus back to where it was when it goes.
//   node --experimental-strip-types --test test/deviceAlertFocus.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountAlertOverSettings: (
    el: unknown,
    settings: Record<string, unknown>,
  ) => { answers: string[]; showAlert: () => void; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountAlertOverSettings.tsx"), [
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

// Where focus is, as text: comparing two DOM nodes in an assertion prints their whole
// object graphs and stalls the run.
function where(): string {
  const el = document.activeElement as unknown as HTMLElement | null;
  if (!el || el === (document.body as unknown as HTMLElement)) return "nothing";
  const label = `${el.tagName.toLowerCase()}: ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}`;
  if (el.closest(".kc-device-alert")) return `alert ${label}`;
  if (el.closest(".kc-settings-dialog")) return `settings ${label}`;
  return `elsewhere ${label}`;
}

function press(key: string, shiftKey = false) {
  const target = document.activeElement ?? document.body;
  bundle.mod.act(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

test("the new-device alert takes the keyboard from Settings, keeps it, and hands it back", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const closed: string[] = [];
  const f = bundle.mod.mountAlertOverSettings(container, {
    currentUser: null,
    pluginManager: {},
    token: "t",
    servers: [],
    dms: [],
    initialTab: "appearance",
    onClose: () => closed.push("settings"),
    onToast() {},
    privacyPrefs: { metadataMode: false },
    onPrivacyPrefsChange() {},
  });
  try {
    const inSettings = where();
    assert.match(inSettings, /^settings /, "Settings has focus when it opens");

    f.showAlert();
    const alert = document.querySelector(".kc-device-alert");
    assert.ok(alert, "the alert is shown");
    assert.equal(alert.getAttribute("role"), "alertdialog", "it is a dialog that needs an answer");
    assert.equal(alert.getAttribute("aria-modal"), "true");
    assert.match(where(), /^alert /, "focus moves into the alert");

    const button = (text: string) =>
      [...alert.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement;
    press("Tab");
    assert.equal(where(), "alert button: It was me", "Tab goes to the alert's first answer");
    // happy-dom has no Tab of its own between controls, so move to the last answer the way
    // the browser would, then check the wrap the alert does itself.
    bundle.mod.act(() => button("Not me").focus());
    press("Tab");
    assert.equal(where(), "alert button: It was me", "Tab from the last answer wraps to the first");
    press("Tab", true);
    assert.equal(where(), "alert button: Not me", "Shift+Tab from the first answer wraps to the last");

    press("Escape");
    assert.deepEqual(closed, [], "Escape in the alert does not close Settings underneath");
    assert.ok(document.querySelector(".kc-device-alert"), "and does not dismiss the question");

    bundle.mod.act(() => button("It was me").click());
    assert.deepEqual(f.answers, ["keep"]);
    assert.equal(document.querySelector(".kc-device-alert") === null, true, "the alert is gone");
    assert.equal(where(), inSettings, "focus is back where it was in Settings");
  } finally {
    f.unmount();
    container.remove();
  }
});
