// The Delete account form on a phone. A phone keyboard capitalises the first letter of a
// text field and often adds a space after a word, so "Type kikka to confirm" came out as
// "Kikka " and the button stayed grey with nothing saying why.
//   node --experimental-strip-types --test test/deleteAccountForm.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type DeleteCall = { password: string; username: string };
type Mod = {
  act: (callback: () => void) => void;
  mountDeleteAccount: (
    el: unknown,
    username: string,
  ) => { calls: DeleteCall[]; deleted: string[]; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountDeleteAccount.tsx"), [
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

function openForm(username: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = bundle.mod.mountDeleteAccount(container, username);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement;
  bundle.mod.act(() => button("Delete account…").click());
  const type = (label: string, value: string) =>
    bundle.mod.act(() => {
      const input = container.querySelector(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  return {
    ...mounted,
    container,
    type,
    submit: () => button("Delete my account"),
    cleanup: () => {
      mounted.unmount();
      container.remove();
    },
  };
}

test("the confirm field asks a phone keyboard not to capitalise or correct it", () => {
  const f = openForm("kikka");
  try {
    const input = f.container.querySelector('input[aria-label="Type your username to confirm"]')!;
    assert.equal(input.getAttribute("autocapitalize"), "none");
    assert.equal(input.getAttribute("autocorrect"), "off");
  } finally {
    f.cleanup();
  }
});

test("a capital first letter and a trailing space still confirm, and the server gets the real username", async () => {
  const f = openForm("kikka");
  try {
    f.type("Password", "hunter22");
    f.type("Type your username to confirm", "Kikka ");
    assert.equal(f.submit().disabled, false, "the delete button is ready");
    bundle.mod.act(() => f.submit().click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(f.calls, [{ password: "hunter22", username: "kikka" }]);
  } finally {
    f.cleanup();
  }
});

test("a different name does not confirm", () => {
  const f = openForm("kikka");
  try {
    f.type("Password", "hunter22");
    f.type("Type your username to confirm", "kikk");
    assert.equal(f.submit().disabled, true);
  } finally {
    f.cleanup();
  }
});

// Opening the form removes the button that opened it: focus goes to the first field, so
// a keyboard or screen reader user lands in the form rather than nowhere.
test("opening the form puts the cursor in the password field", () => {
  const f = openForm("kikka");
  try {
    // Compared by label: a failed comparison of two DOM nodes prints their whole object graphs.
    assert.equal(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName, "Password");
  } finally {
    f.cleanup();
  }
});

// The list of what deleting does left out three things people would want to know first.
test("the form says what happens to group chats, one-to-one chats and the username", () => {
  const f = openForm("kikka");
  try {
    const said = f.container.textContent ?? "";
    assert.match(said, /Group chats you started go to the next person in them/);
    assert.match(said, /one-to-one chats, the other person sees .Deleted account. and can.t reply/);
    assert.match(said, /Your username becomes free, and someone else can take it/);
  } finally {
    f.cleanup();
  }
});
