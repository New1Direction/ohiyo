// Public interactions, through the real API client and a deterministic HTTP boundary.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountRecoverySettings: (el: unknown, needsCode?: boolean) => { unmount: () => void };
  mountRecoveryDoor: (el: unknown) => { signedIn: string[]; unmount: () => void };
};
let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
const accountCode = "ACCT-abcdefghijklmnopqrstuvwxyz-234567";
type Call = { path: string; method: string; headers: Headers; body: Record<string, string> };
const calls: Call[] = [];
let enabled = false;
let secondFactor = false;
let failure: { status: number; message: string } | null = null;
let hold: Promise<void> | null = null;

before(async () => {
  const globals = { window, document, navigator: window.navigator, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage, HTMLElement: window.HTMLElement,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit = {}) => {
      const call: Call = { path: new URL(url, "http://localhost").pathname, method: init.method ?? "GET", headers: new Headers(init.headers), body: JSON.parse(String(init.body ?? "{}")) };
      calls.push(call);
      if (hold) await hold;
      if (failure) return new Response(failure.message, { status: failure.status });
      if (call.path.endsWith("/account-recovery") && call.method === "GET") return Response.json({ enabled });
      if (call.path.endsWith("/account-recovery")) {
        if (call.body.password !== "current-password") return new Response("that isn't your password", { status: 403 });
        if (secondFactor && !call.body.two_factor_code) return new Response("enter the code from your authenticator app", { status: 403 });
        if (secondFactor && call.body.two_factor_code !== "123456") return new Response("that code isn't right", { status: 403 });
        enabled = true;
        return Response.json({ recovery_code: accountCode });
      }
      if (call.path.endsWith("/auth/recover")) {
        // Recovery deliberately does not reveal whether the account or second factor matched.
        if (call.body.recovery_code !== accountCode) return new Response("invalid credentials", { status: 401 });
        if (secondFactor && !["123456", "ABCD-EFGH-JKLM-NPQR"].includes(call.body.two_factor_code)) return new Response("invalid credentials", { status: 401 });
        enabled = false;
        return new Response(null, { status: 204 });
      }
      if (call.path.endsWith("/password")) {
        enabled = false;
        return Response.json({ token: "fresh-session" });
      }
      if (call.path.endsWith("/auth/login")) return Response.json({ token: "sign-in-session", user: { id: "u1" } });
      throw new Error(`Unexpected request ${call.method} ${call.path}`);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountAccountRecovery.tsx"), [
    { find: /^@privacyresearch\/libsignal-protocol-typescript$/, replacement: join(fixtures, "libsignalStub.ts") },
  ]);
});

beforeEach(() => {
  calls.length = 0;
  enabled = false;
  secondFactor = false;
  failure = null;
  hold = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)); };
function mount(door = false, needsCode = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = door ? bundle.mod.mountRecoveryDoor(container) : bundle.mod.mountRecoverySettings(container, needsCode);
  const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`);
  const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  return {
    container, input, button,
    signedIn: "signedIn" in mounted ? mounted.signedIn : [],
    text: () => container.textContent ?? "",
    type: (label: string, value: string) => bundle.mod.act(() => {
      const field = input(label);
      assert.ok(field, label);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }),
    click: (label: string) => bundle.mod.act(() => { const b = button(label); assert.ok(b, label); b.click(); }),
    submit: (label: string) => bundle.mod.act(() => {
      const form = container.querySelector(`form[aria-label="${label}"]`);
      assert.ok(form, label);
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    }),
    cleanup: () => { mounted.unmount(); container.remove(); },
  };
}

function fillRecovery(f: ReturnType<typeof mount>) {
  f.click("Forgot your password?");
  f.type("Username", "alice");
  f.type("Account recovery code", accountCode);
  f.type("New password", "a-new-password");
  f.type("New password again", "a-new-password");
}

test("generation requires the current password, displays once, copies and downloads without persistence", async () => {
  const f = mount();
  const blobs: Blob[] = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:recovery-download"; };
  URL.revokeObjectURL = () => {};
  try {
    assert.match(f.text(), /Checking account recovery/);
    await settle();
    assert.equal(calls[0].headers.get("Authorization"), "Bearer test-session");
    f.click("Set up account recovery");
    f.type("Your password", "wrong-password");
    f.submit("Confirm with your password");
    await settle();
    assert.match(f.text(), /isn't your password/);
    f.type("Your password", "current-password");
    f.submit("Confirm with your password");
    await settle();
    assert.match(f.text(), /shown only once/);
    assert.ok(f.text().includes(accountCode));
    assert.equal(f.input("Your password"), null);
    f.click("Copy code");
    await settle();
    assert.equal(await window.navigator.clipboard.readText(), accountCode);
    f.click("Download code");
    assert.equal(blobs.length, 1);
    assert.match(await blobs[0].text(), /Not a two-factor backup code/);
    assert.ok((await blobs[0].text()).includes(accountCode));
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    f.click("I've saved it");
    assert.ok(!f.text().includes(accountCode));
    assert.ok(f.button("Replace account recovery code"));
    f.click("Replace account recovery code");
    assert.equal(f.input("Your password")?.getAttribute("value"), "");
    assert.match(f.text(), /invalidates the old one/);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; f.cleanup(); }
});

test("a second-factor challenge can appear late; wrong codes remain errors and cancel clears both fields", async () => {
  secondFactor = true;
  const f = mount();
  try {
    await settle();
    f.click("Set up account recovery");
    f.type("Your password", "current-password");
    f.submit("Confirm with your password");
    await settle();
    assert.ok(f.input("Authenticator code or two-factor backup code"));
    f.type("Authenticator code or two-factor backup code", "000000");
    f.submit("Confirm with your password");
    await settle();
    assert.match(f.text(), /code isn't right/);
    f.click("Cancel");
    f.click("Set up account recovery");
    assert.equal(f.input("Your password")?.getAttribute("value"), "");
    assert.equal(f.input("Authenticator code or two-factor backup code"), null);
    f.type("Your password", "current-password");
    f.submit("Confirm with your password");
    await settle();
    f.type("Authenticator code or two-factor backup code", "123 456");
    f.submit("Confirm with your password");
    await settle();
    assert.equal(calls.at(-1)?.body.two_factor_code, "123456");
    assert.ok(f.text().includes(accountCode));
  } finally { f.cleanup(); }
});

test("a known second factor blocks generation until supplied", async () => {
  const f = mount(false, true);
  try {
    await settle();
    f.click("Set up account recovery");
    f.type("Your password", "current-password");
    assert.equal(f.button("Create recovery code")?.disabled, true);
    f.type("Authenticator code or two-factor backup code", "123456");
    assert.equal(f.button("Create recovery code")?.disabled, false);
  } finally { f.cleanup(); }
});

test("status failures are not presented as no code, and unsupported servers cannot generate", async () => {
  failure = { status: 500, message: "offline" };
  const f = mount();
  try {
    await settle();
    assert.match(f.text(), /Couldn't check account recovery/);
    assert.equal(f.button("Set up account recovery"), undefined);
    failure = { status: 404, message: "not found" };
    f.click("Try again");
    await settle();
    assert.match(f.text(), /isn't available on this server/);
    assert.equal(f.button("Set up account recovery"), undefined);
  } finally { f.cleanup(); }
});

test("password changes remove a displayed code and reload disabled recovery status", async () => {
  const f = mount();
  try {
    await settle();
    f.click("Set up account recovery");
    f.type("Your password", "current-password");
    f.submit("Confirm with your password");
    await settle();
    assert.ok(f.text().includes(accountCode));
    f.type("Current password", "current-password");
    f.type("New password", "new-password");
    f.type("New password again", "new-password");
    f.submit("Change password");
    await settle();
    assert.ok(!f.text().includes(accountCode));
    assert.ok(f.button("Set up account recovery"));
    assert.equal(calls.at(-1)?.headers.get("Authorization"), "Bearer fresh-session");
  } finally { f.cleanup(); }
});

test("recovery completes with no bearer or session and returns to ordinary sign-in", async () => {
  const f = mount(true);
  try {
    fillRecovery(f);
    f.submit("Recover account");
    await settle();
    const request = calls[0];
    assert.ok(request.path.endsWith("/auth/recover"));
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("Authorization"), null);
    assert.deepEqual(request.body, { username: "alice", recovery_code: accountCode, new_password: "a-new-password" });
    assert.deepEqual(f.signedIn, []);
    assert.match(f.text(), /Password reset\. Sign in/);
    assert.match(f.text(), /save a new account recovery code/);
    assert.equal(f.input("Account recovery code"), null);
    assert.equal(f.input("Password")?.getAttribute("value"), "");
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    f.type("Password", "a-new-password");
    f.submit("Sign in");
    await settle();
    assert.deepEqual(f.signedIn, ["sign-in-session"]);
  } finally { f.cleanup(); }
});

test("recovery explains generic credential refusals, requires the second factor, and accepts a 2FA backup code", async () => {
  secondFactor = true;
  const f = mount(true);
  try {
    fillRecovery(f);
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /Check your username, account recovery code, and second factor/);
    assert.deepEqual(f.signedIn, []);
    f.type("Authenticator code or two-factor backup code", "000000");
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /Check your username, account recovery code, and second factor/);
    assert.deepEqual(f.signedIn, []);
    f.type("Authenticator code or two-factor backup code", "ABCD-EFGH-JKLM-NPQR");
    f.submit("Recover account");
    await settle();
    assert.equal(calls.at(-1)?.body.two_factor_code, "ABCD-EFGH-JKLM-NPQR");
    assert.deepEqual(f.signedIn, []);
    assert.match(f.text(), /Password reset/);
  } finally { f.cleanup(); }
});

test("cancelling recovery or choosing device linking clears all secrets", async () => {
  const f = mount(true);
  try {
    f.type("Password", "old-secret");
    fillRecovery(f);
    f.type("Authenticator code or two-factor backup code", "123456");
    f.click("Back to sign in");
    assert.equal(f.input("Password")?.getAttribute("value"), "");
    f.click("Forgot your password?");
    for (const label of ["Account recovery code", "New password", "New password again", "Authenticator code or two-factor backup code"]) {
      assert.equal(f.input(label)?.getAttribute("value"), "", label);
    }
    f.type("Account recovery code", accountCode);
    f.click("Link a device instead");
    assert.ok(f.input("Device-link code"));
    assert.equal(f.input("Account recovery code"), null);
    assert.equal(calls.length, 0);
  } finally { f.cleanup(); }
});

test("unsupported recovery leaves sign-in and device linking available; network errors do not claim failure certainty", async () => {
  const f = mount(true);
  try {
    fillRecovery(f);
    failure = { status: 503, message: "unavailable" };
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /reset may have completed/);
    failure = { status: 404, message: "not found" };
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /isn't available on this server/);
    assert.equal(f.button("Reset password")?.disabled, true);
    assert.equal(f.button("Back to sign in")?.disabled, false);
    assert.equal(f.button("Link a device instead")?.disabled, false);
  } finally { f.cleanup(); }
});

test("pending requests block duplicates, and a late reset after unmount never signs in", async () => {
  const f = mount(true);
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  fillRecovery(f);
  f.submit("Recover account");
  f.submit("Recover account");
  assert.equal(calls.length, 1);
  assert.equal(f.button("Resetting password…")?.disabled, true);
  f.cleanup();
  release();
  await settle();
  assert.deepEqual(f.signedIn, []);
});

test("invalid account codes and rate limits never complete recovery", async () => {
  const f = mount(true);
  try {
    fillRecovery(f);
    f.type("Account recovery code", "wrong-or-used-code");
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /may already have been used or replaced/);
    failure = { status: 429, message: "too many attempts" };
    f.submit("Recover account");
    await settle();
    assert.match(f.text(), /Too many attempts/);
    assert.deepEqual(f.signedIn, []);
    assert.ok(f.input("Account recovery code"));
  } finally { f.cleanup(); }
});

test("generation errors explain uncertain rotation and clipboard errors keep the only copy visible", async () => {
  const f = mount();
  const writeText = window.navigator.clipboard.writeText;
  try {
    await settle();
    f.click("Set up account recovery");
    f.type("Your password", "current-password");
    failure = { status: 502, message: "connection lost" };
    f.submit("Confirm with your password");
    await settle();
    assert.match(f.text(), /If the request went through, your old code was replaced/);
    failure = null;
    f.submit("Confirm with your password");
    await settle();
    window.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    f.click("Copy code");
    await settle();
    assert.match(f.text(), /Couldn't copy/);
    assert.ok(f.text().includes(accountCode));
    assert.ok(f.button("Download code"));
    assert.ok(f.button("I've saved it"));
  } finally { window.navigator.clipboard.writeText = writeText; f.cleanup(); }
});

test("closing settings during generation discards the late code; reopening never fetches it", async () => {
  let release!: () => void;
  const f = mount();
  await settle();
  f.click("Set up account recovery");
  f.type("Your password", "current-password");
  hold = new Promise<void>((resolve) => { release = resolve; });
  f.submit("Confirm with your password");
  f.submit("Confirm with your password");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  f.cleanup();
  release();
  await settle();
  hold = null;
  const reopened = mount();
  try {
    await settle();
    assert.ok(!reopened.text().includes(accountCode));
    assert.ok(reopened.button("Replace account recovery code"));
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
  } finally { reopened.cleanup(); }
});
