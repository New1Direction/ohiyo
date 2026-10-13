// The space's header used to show a row of unlabelled icons under its name (logo, events,
// report, moderation queue, ⋯). Like Discord, the name itself now opens one labelled menu
// with those actions; the Invite button stays beside it.
//   node --experimental-strip-types --test test/spaceMenu.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountChannelSidebar: (el: unknown, opts: { owner: boolean; manage: boolean; invites?: boolean; bans?: boolean }) => { calls: string[]; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountChannelSidebar.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type El = { textContent: string | null; getAttribute(name: string): string | null; click(): void; focus(): void };

function mount(opts: { owner: boolean; manage: boolean; invites?: boolean; bans?: boolean }) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountChannelSidebar(container, opts);
  return {
    ...f,
    container,
    nameButton: () => container.querySelector('button[aria-haspopup="menu"]') as unknown as El | null,
    menu: () => container.querySelector('[role="menu"]'),
    items: () => [...container.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? "").trim()),
    item: (label: string) =>
      [...container.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent ?? "").trim() === label) as unknown as El | undefined,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

// What has focus, as text: comparing DOM nodes in an assertion prints their whole graphs.
function focused(): string {
  const el = document.activeElement as unknown as El | null;
  if (!el) return "nothing";
  const role = el.getAttribute("role");
  const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
  return role === "menuitem" ? `item: ${label}` : el.getAttribute("aria-haspopup") === "menu" ? "the space name" : `other: ${label}`;
}

function press(key: string) {
  const target = document.activeElement ?? document.body;
  bundle.mod.act(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

test("the space name is a button that opens a menu, and the header keeps no unlabelled icons", () => {
  const f = mount({ owner: false, manage: false });
  try {
    const name = f.nameButton();
    assert.ok(name, "the space name is a button with a menu");
    assert.match(name.textContent ?? "", /Gate HQ/);
    assert.equal(name.getAttribute("aria-expanded"), "false");
    for (const gone of ["Events", "Moderation queue", "Space options", "Change server logo", "Report server"]) {
      assert.equal(f.container.querySelector(`button[aria-label="${gone}"]`), null, `no "${gone}" icon in the header`);
    }
    assert.ok(f.container.querySelector('button[aria-label="Invite people"]'), "the Invite button stays");
    assert.equal(f.menu(), null, "the menu starts closed");

    bundle.mod.act(() => name.click());
    assert.ok(f.menu(), "a click opens the menu");
    assert.equal(name.getAttribute("aria-expanded"), "true");
  } finally {
    f.done();
  }
});

test("a member's menu: invite, events, report, and leave last", () => {
  const f = mount({ owner: false, manage: false });
  try {
    bundle.mod.act(() => f.nameButton()!.click());
    assert.deepEqual(f.items(), ["Invite people", "Events", "Report space", "Leave space"]);
  } finally {
    f.done();
  }
});

test("an owner who manages the space: logo, channels and the moderation queue, and delete last", () => {
  const f = mount({ owner: true, manage: true });
  try {
    bundle.mod.act(() => f.nameButton()!.click());
    assert.deepEqual(f.items(), ["Invite people", "Change space logo", "Create channel", "Events", "Moderation queue", "Delete space"]);
  } finally {
    f.done();
  }
});

test("moderators also get the invite list after Invite people, and the ban list after the moderation queue", () => {
  const f = mount({ owner: true, manage: true, invites: true, bans: true });
  try {
    bundle.mod.act(() => f.nameButton()!.click());
    assert.deepEqual(f.items(), [
      "Invite people",
      "Invites",
      "Change space logo",
      "Create channel",
      "Events",
      "Moderation queue",
      "Bans",
      "Delete space",
    ]);
    bundle.mod.act(() => f.item("Bans")!.click());
    bundle.mod.act(() => f.nameButton()!.click());
    bundle.mod.act(() => f.item("Invites")!.click());
    assert.deepEqual(f.calls, ["bans", "invites"]);
  } finally {
    f.done();
  }
});

test("the keyboard opens the menu, moves through it, and Escape gives focus back to the name", () => {
  const f = mount({ owner: false, manage: false });
  try {
    f.nameButton()!.focus();
    press("ArrowDown");
    assert.ok(f.menu(), "ArrowDown on the name opens the menu");
    assert.equal(focused(), "item: Invite people");
    press("ArrowDown");
    assert.equal(focused(), "item: Events");
    press("End");
    assert.equal(focused(), "item: Leave space");
    press("ArrowDown");
    assert.equal(focused(), "item: Invite people", "ArrowDown wraps to the top");
    press("ArrowUp");
    assert.equal(focused(), "item: Leave space", "ArrowUp wraps to the bottom");
    press("Escape");
    assert.equal(f.menu(), null, "Escape closes the menu");
    assert.equal(focused(), "the space name");
  } finally {
    f.done();
  }
});

test("choosing an item closes the menu and does what it says", () => {
  const f = mount({ owner: false, manage: false });
  try {
    bundle.mod.act(() => f.nameButton()!.click());
    bundle.mod.act(() => f.item("Events")!.click());
    assert.deepEqual(f.calls, ["events"]);
    assert.equal(f.menu(), null);

    bundle.mod.act(() => f.nameButton()!.click());
    bundle.mod.act(() => f.item("Leave space")!.click());
    assert.equal(f.menu(), null);
    const confirm = [...f.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Leave space");
    assert.ok(confirm, "leaving still asks first, with its own Leave space button");
    assert.deepEqual(f.calls, ["events"], "nothing is left until that is pressed");
  } finally {
    f.done();
  }
});

test("a click outside closes the menu", () => {
  const f = mount({ owner: true, manage: true });
  try {
    bundle.mod.act(() => f.nameButton()!.click());
    assert.ok(f.menu());
    bundle.mod.act(() => {
      document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    });
    assert.equal(f.menu(), null);
  } finally {
    f.done();
  }
});

test("a set-up space's sidebar carries no permanent hint card", () => {
  // "Ready when you are" sat under the channels of every space for good; it was only hidden
  // while the getting-started checklist showed, so it surfaced once the checklist was done.
  const f = mount({ owner: true, manage: true });
  try {
    assert.equal((f.container.textContent ?? "").includes("Ready when you are"), false);
  } finally {
    f.done();
  }
});
