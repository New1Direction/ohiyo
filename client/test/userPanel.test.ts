// The bar at the foot of the channel sidebar is two lines, like Discord's: your name, then
// your status. Activity and signing out live in the menu that opens from it; Settings stays
// one click away. The owner checklist goes once every step is done.
//   node --experimental-strip-types --test test/userPanel.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountUserPanel: (
    el: unknown,
    init?: { status?: string | null; activity?: { kind: string; name: string } | null; privacyMode?: boolean },
  ) => { calls: string[]; unmount: () => void };
  mountChecklist: (el: unknown, state: Record<string, number | null>) => { unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountUserPanel.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function mount(init?: Parameters<Mod["mountUserPanel"]>[1]) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountUserPanel(container, init);
  const panel = container.querySelector(".kc-user-panel");
  assert.ok(panel, "the user panel renders");
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const lines = () => [...panel.querySelectorAll("[data-user-line]")].map((l) => text(l));
  const trigger = () => panel.querySelector('button[aria-haspopup="dialog"]') as unknown as HTMLButtonElement | null;
  const menu = () => panel.querySelector('[role="dialog"]');
  const buttonIn = (root: Element | null, label: string) =>
    [...(root?.querySelectorAll("button") ?? [])].find(
      (b) => text(b) === label || b.getAttribute("aria-label") === label,
    ) as unknown as HTMLButtonElement | undefined;
  const open = () => {
    const t = trigger();
    assert.ok(t, "the bar opens a menu");
    bundle.mod.act(() => t.click());
    assert.ok(menu(), "the menu is open");
  };
  const keydown = (target: Element, key: string) =>
    bundle.mod.act(() => {
      target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const done = () => {
    f.unmount();
    container.remove();
  };
  return { f, panel, text, lines, trigger, menu, buttonIn, open, keydown, done };
}

test("the bar is two lines: your name, then Set a status", () => {
  const p = mount();
  try {
    assert.deepEqual(p.lines(), ["kikka", "Set a status"]);
    assert.doesNotMatch(p.text(p.panel), /\+ Activity/, "adding an activity is not a third line any more");
  } finally {
    p.done();
  }
});

test("your status is the second line when you have one", () => {
  const p = mount({ status: "deep work" });
  try {
    assert.deepEqual(p.lines(), ["kikka", "deep work"]);
  } finally {
    p.done();
  }
});

test("with no status, an activity you set takes the second line", () => {
  const p = mount({ activity: { kind: "playing", name: "Chess" } });
  try {
    assert.equal(p.lines().length, 2);
    assert.match(p.lines()[1], /Playing Chess/);
  } finally {
    p.done();
  }
});

test("the menu holds your status, an activity and signing out", () => {
  const p = mount();
  try {
    p.open();
    const menu = p.menu();
    assert.equal(menu?.getAttribute("aria-label"), "Your status");
    assert.ok(menu?.querySelector('input[aria-label="Status"]'), "a status field");
    assert.ok(p.buttonIn(menu, "Add an activity"), "an Add an activity button");
    assert.ok(p.buttonIn(menu, "Sign out…"), "a Sign out… button");
  } finally {
    p.done();
  }
});

test("a status typed in the menu is saved with Enter", () => {
  const p = mount();
  try {
    p.open();
    const field = p.menu()?.querySelector('input[aria-label="Status"]') as unknown as HTMLInputElement;
    field.value = "brb";
    p.keydown(field as unknown as Element, "Enter");
    assert.deepEqual(p.f.calls, ["status:brb"]);
    assert.deepEqual(p.lines(), ["kikka", "brb"]);
  } finally {
    p.done();
  }
});

test("an activity is added from the menu", () => {
  const p = mount();
  try {
    p.open();
    bundle.mod.act(() => p.buttonIn(p.menu(), "Add an activity")!.click());
    const menu = p.menu();
    assert.ok(menu?.querySelector('select[aria-label="Activity type"]'), "a kind to pick");
    const name = menu?.querySelector('input[aria-label="Activity name"]') as unknown as HTMLInputElement;
    assert.ok(name, "a name to type");
    name.value = "Chess";
    p.keydown(name as unknown as Element, "Enter");
    assert.deepEqual(p.f.calls, ["activity:playing Chess"]);
    // The name field goes once it's saved; the keyboard must stay in the menu so Escape
    // still closes it (it used to fall to the page).
    const active = document.activeElement as unknown as Element | null;
    assert.equal(Boolean(active?.closest('[role="dialog"]')), true, "focus stays in the menu");
    p.keydown(active!, "Escape");
    assert.equal(p.menu() === null, true, "Escape closes the menu");
  } finally {
    p.done();
  }
});

test("Sign out… in the menu asks to sign out", () => {
  const p = mount();
  try {
    p.open();
    bundle.mod.act(() => p.buttonIn(p.menu(), "Sign out…")!.click());
    assert.deepEqual(p.f.calls, ["logout"]);
  } finally {
    p.done();
  }
});

test("Escape closes the menu and puts focus back on the bar", () => {
  const p = mount();
  try {
    p.open();
    p.keydown(p.menu()!, "Escape");
    // Compare with === null: a failing assert.equal on a DOM node prints its whole object
    // graph and stalls the run.
    assert.equal(p.menu() === null, true, "the menu is closed");
    const active = document.activeElement as unknown as Element | null;
    assert.equal(active?.getAttribute("aria-haspopup"), "dialog", "focus is back on the bar");
  } finally {
    p.done();
  }
});

test("Settings stays one click away, outside the menu", () => {
  const p = mount();
  try {
    const settings = p.buttonIn(p.panel, "Settings");
    assert.ok(settings, "a Settings button on the bar");
    bundle.mod.act(() => settings.click());
    assert.deepEqual(p.f.calls, ["settings"]);
  } finally {
    p.done();
  }
});

const ALL = { account: 1, server: 1, message: 1, invite: 1, call: 1 };

test("a finished owner checklist is not shown", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountChecklist(container, ALL);
  try {
    assert.equal(container.querySelector(".kc-activation") === null, true, "no 'All set 5 of 5' card");
  } finally {
    f.unmount();
    container.remove();
  }
});

test("an unfinished owner checklist still shows how far along it is", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountChecklist(container, { ...ALL, invite: null, call: null, message: null });
  try {
    const summary = container.querySelector(".kc-activation > summary");
    assert.ok(summary, "the checklist row is there");
    assert.match(summary.textContent ?? "", /Getting started/);
    assert.match(summary.textContent ?? "", /2 of 5/);
  } finally {
    f.unmount();
    container.remove();
  }
});
