// Two-factor sign-in on screen. Signing in asks for a code after the password, takes a
// recovery code instead, and says plainly when a code is wrong. In Settings, turning it on
// goes password, QR code and setup key, a code, then recovery codes to save; turning it off
// needs the password and a code; a server that can't do it says so; a change on another
// device shows up without hiding codes still being saved. With it on, changing the password
// asks for a code too.
//   node --experimental-strip-types --test test/twoFactorUi.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Status = { enabled: boolean; available: boolean; recovery_codes_left: number };
type Mod = {
  act: (callback: () => void) => void;
  mountTwoFactorSignIn: (el: unknown) => { calls: string[]; signedIn: string[]; unmount: () => void };
  mountTwoFactorCard: (
    el: unknown,
    start: Status,
  ) => { calls: string[]; changes: boolean[]; codes: string[]; changeElsewhere: (enabled: boolean) => void; unmount: () => void };
  mountChangePasswordWithCode: (el: unknown) => { sent: unknown[][]; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountTwoFactor.tsx"), [
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

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 5));
};

function screen(container: HTMLElement) {
  const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as unknown as HTMLInputElement | null;
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement | undefined;
  return {
    input,
    button,
    text: () => container.textContent ?? "",
    type: (label: string, value: string) =>
      bundle.mod.act(() => {
        const el = input(label);
        assert.ok(el, `a field labelled "${label}"`);
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
      }),
    click: (text: string) =>
      bundle.mod.act(() => {
        const b = button(text);
        assert.ok(b, `a button "${text}" (there are: ${[...container.querySelectorAll("button")].map((x) => x.textContent?.trim()).join(" | ")})`);
        b.click();
      }),
    submit: (label: string) =>
      bundle.mod.act(() => {
        const form = container.querySelector(`form[aria-label="${label}"]`);
        assert.ok(form, `a form "${label}"`);
        form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      }),
  };
}

function mount<T extends { unmount: () => void }>(make: (el: HTMLElement) => T) {
  window.localStorage.clear();
  const container = document.createElement("div") as unknown as HTMLElement;
  document.body.append(container as never);
  const mounted = make(container);
  return {
    ...mounted,
    container,
    ui: screen(container),
    cleanup: () => {
      mounted.unmount();
      container.remove();
    },
  };
}

test("with two-factor on, signing in asks for a code after the password, and the code signs in", async () => {
  const door = mount((el) => bundle.mod.mountTwoFactorSignIn(el));
  try {
    door.ui.type("Username", "alice");
    door.ui.type("Password", "a-good-password");
    door.ui.submit("Sign in");
    await settle();
    assert.deepEqual(door.calls, ["login alice a-good-password"]);
    assert.deepEqual(door.signedIn, [], "the password alone doesn't sign in");

    const field = door.ui.input("Code from your authenticator app");
    assert.ok(field, "a code field after the password");
    assert.equal(field.getAttribute("inputmode"), "numeric", "a number pad on phones");
    assert.equal(field.getAttribute("autocomplete"), "one-time-code");

    door.ui.type("Code from your authenticator app", "123 456");
    door.ui.submit("Two-factor code");
    await settle();
    assert.deepEqual(door.calls.slice(1), ["code chal-1 123456"]);
    assert.deepEqual(door.signedIn, ["session-token"]);
  } finally {
    door.cleanup();
  }
});

test("a wrong code is said plainly, and another can be tried", async () => {
  const door = mount((el) => bundle.mod.mountTwoFactorSignIn(el));
  try {
    door.ui.type("Username", "alice");
    door.ui.type("Password", "a-good-password");
    door.ui.submit("Sign in");
    await settle();
    door.ui.type("Code from your authenticator app", "000000");
    door.ui.submit("Two-factor code");
    await settle();
    assert.match(door.ui.text(), /isn't right/);
    assert.deepEqual(door.signedIn, []);
    door.ui.type("Code from your authenticator app", "654321");
    door.ui.submit("Two-factor code");
    await settle();
    assert.deepEqual(door.signedIn, ["session-token"]);
  } finally {
    door.cleanup();
  }
});

test("a recovery code can be used instead of the app", async () => {
  const door = mount((el) => bundle.mod.mountTwoFactorSignIn(el));
  try {
    door.ui.type("Username", "alice");
    door.ui.type("Password", "a-good-password");
    door.ui.submit("Sign in");
    await settle();
    door.ui.click("Use a recovery code instead");
    const field = door.ui.input("Recovery code");
    assert.ok(field, "a recovery code field");
    assert.notEqual(field.getAttribute("inputmode"), "numeric", "letters too");
    door.ui.type("Recovery code", "abcd-efgh-jklm-npqr");
    door.ui.submit("Two-factor code");
    await settle();
    assert.deepEqual(door.calls.slice(1), ["code chal-1 abcd-efgh-jklm-npqr"]);
    assert.deepEqual(door.signedIn, ["session-token"]);
  } finally {
    door.cleanup();
  }
});

test("turning it on: password, then the QR code and setup key, then a code, then recovery codes to save", async () => {
  const card = mount((el) => bundle.mod.mountTwoFactorCard(el, { enabled: false, available: true, recovery_codes_left: 0 }));
  try {
    await settle();
    assert.match(card.ui.text(), /Off/);
    card.ui.click("Turn on two-factor sign-in");
    card.ui.type("Password", "wrong-password");
    card.ui.submit("Confirm it's you");
    await settle();
    assert.match(card.ui.text(), /isn't your password/i);

    card.ui.type("Password", "right-password");
    card.ui.submit("Confirm it's you");
    await settle();
    assert.ok(card.container.querySelector('[aria-label="QR code for your authenticator app"]'), "a QR code to scan");
    const key = card.container.querySelector('[aria-label="Setup key"]');
    assert.ok(key, "the key, for an app that can't scan");
    assert.equal((key.textContent ?? "").replace(/\s/g, ""), "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");

    card.ui.type("6-digit code", "123456");
    card.ui.submit("Turn on two-factor sign-in");
    await settle();
    for (const code of card.codes) assert.ok(card.ui.text().includes(code), `recovery code ${code} shown`);
    assert.ok(card.ui.button("Download"), "the codes can be saved to a file");
    assert.ok(card.ui.button("Copy"), "or copied");
    assert.deepEqual(card.changes.at(-1), true, "the tab hears it's on");

    card.ui.click("I've saved them");
    await settle();
    assert.match(card.ui.text(), /\bOn\b/);
    assert.match(card.ui.text(), /10 recovery codes left/);
    assert.ok(!card.ui.text().includes(card.codes[0]), "the codes aren't shown again");
  } finally {
    card.cleanup();
  }
});

test("a change on another device shows up, and this device's own change doesn't hide the recovery codes", async () => {
  const card = mount((el) => bundle.mod.mountTwoFactorCard(el, { enabled: false, available: true, recovery_codes_left: 0 }));
  // What App.tsx sends when the gateway says it changed (on any of the account's devices).
  const announce = () => window.dispatchEvent(new window.Event("ohiyo:two-factor"));
  try {
    await settle();
    assert.match(card.ui.text(), /\bOff\b/);
    card.changeElsewhere(true);
    announce();
    await settle();
    assert.match(card.ui.text(), /\bOn\b/, "the card reads the status again");
    assert.deepEqual(card.changes.at(-1), true, "and the tab hears it");

    card.changeElsewhere(false);
    announce();
    await settle();
    card.ui.click("Turn on two-factor sign-in");
    card.ui.type("Password", "right-password");
    card.ui.submit("Confirm it's you");
    await settle();
    card.ui.type("6-digit code", "123456");
    card.ui.submit("Turn on two-factor sign-in");
    await settle();
    // The server announces this change to every device, this one included.
    announce();
    await settle();
    for (const code of card.codes) assert.ok(card.ui.text().includes(code), `recovery code ${code} still shown`);
    assert.ok(card.ui.button("I've saved them"), "still waiting for the person to save them");
  } finally {
    card.cleanup();
  }
});

test("turning it off needs the password and a code", async () => {
  const card = mount((el) => bundle.mod.mountTwoFactorCard(el, { enabled: true, available: true, recovery_codes_left: 7 }));
  try {
    await settle();
    assert.match(card.ui.text(), /7 recovery codes left/);
    card.ui.click("Turn off");
    card.ui.type("Password", "right-password");
    card.ui.type("Code", "123456");
    card.ui.submit("Turn off two-factor sign-in");
    await settle();
    assert.ok(card.calls.includes("disable right-password 123456"), card.calls.join(", "));
    assert.match(card.ui.text(), /Off/);
    assert.deepEqual(card.changes.at(-1), false);
  } finally {
    card.cleanup();
  }
});

test("a server that can't do it says so and offers nothing to press", async () => {
  const card = mount((el) => bundle.mod.mountTwoFactorCard(el, { enabled: false, available: false, recovery_codes_left: 0 }));
  try {
    await settle();
    assert.match(card.ui.text(), /isn't available on this server/i);
    assert.equal(card.ui.button("Turn on two-factor sign-in"), undefined);
  } finally {
    card.cleanup();
  }
});

test("with two-factor on, changing the password asks for a code too", async () => {
  const form = mount((el) => bundle.mod.mountChangePasswordWithCode(el));
  try {
    form.ui.type("Current password", "old-password-1");
    form.ui.type("New password", "new-password-2");
    form.ui.type("New password again", "new-password-2");
    assert.ok(form.ui.input("Code from your authenticator app"), "a code field");
    form.ui.type("Code from your authenticator app", "123456");
    form.ui.submit("Change password");
    await settle();
    assert.equal(form.sent.length, 1);
    assert.deepEqual(form.sent[0].slice(1), ["old-password-1", "new-password-2", "123456"]);
  } finally {
    form.cleanup();
  }
});
