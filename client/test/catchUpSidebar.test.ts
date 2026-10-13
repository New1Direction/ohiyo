// Catching up from the sidebar, like Discord: right-click (or long-press) a channel for
// "Mark as read", "Mark space as read" in the space menu, and a pencil beside any chat with an
// unsent draft.
//   node --experimental-strip-types --test test/catchUpSidebar.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  persistDraft: (channelId: string, text: string, encrypted: boolean) => void;
  forgetAllDrafts: () => void;
  mountChannelSidebar: (
    el: unknown,
    opts: { owner: boolean; manage: boolean; unread?: Record<string, number>; markRead?: boolean },
  ) => { calls: string[]; unmount: () => void };
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

function mount(opts: { unread?: Record<string, number> } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountChannelSidebar(container, { owner: true, manage: true, markRead: true, ...opts });
  const row = (name: string) =>
    [...container.querySelectorAll(".kc-channel-row")].find((el) => (el.textContent ?? "").includes(name));
  return {
    ...f,
    container,
    row,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

const labels = (root: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> }, selector: string) =>
  [...Array.from(root.querySelectorAll(selector))].map((el) => (el.textContent ?? "").trim());

test("right-clicking a channel offers Mark as read, which marks that channel", () => {
  const f = mount({ unread: { c3: 4 } });
  try {
    const random = f.row("random");
    assert.ok(random, "#random is listed");
    bundle.mod.act(() => {
      random!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }));
    });
    const menu = document.querySelector('[role="menu"][aria-label="random"]');
    assert.ok(menu, "a menu for #random opens");
    assert.deepEqual(labels(menu!, '[role="menuitem"]'), ["Mark as read"]);
    const item = menu!.querySelector('[role="menuitem"]') as unknown as { click(): void };
    bundle.mod.act(() => item.click());
    assert.deepEqual(f.calls, ["mark read c3"]);
    assert.equal(document.querySelector('[role="menu"][aria-label="random"]'), null, "the menu closes");
  } finally {
    f.done();
  }
});

test("the space menu offers Mark space as read", () => {
  const f = mount({ unread: { c3: 4 } });
  try {
    const name = f.container.querySelector('button[aria-haspopup="menu"]') as unknown as { click(): void };
    bundle.mod.act(() => name.click());
    const items = labels(f.container, '[role="menuitem"]');
    assert.ok(items.includes("Mark space as read"), `the space menu lists: ${items.join(", ")}`);
    const item = [...f.container.querySelectorAll('[role="menuitem"]')].find(
      (el) => (el.textContent ?? "").trim() === "Mark space as read",
    ) as unknown as { click(): void };
    bundle.mod.act(() => item.click());
    assert.deepEqual(f.calls, ["mark space read"]);
  } finally {
    f.done();
  }
});

test("a chat with an unsent draft shows a pencil; the open chat doesn't", () => {
  bundle.mod.forgetAllDrafts();
  bundle.mod.persistDraft("c3", "half a thought", false);
  bundle.mod.persistDraft("c1", "typing here", false); // c1 is the open channel
  const f = mount();
  try {
    assert.ok(f.row("random")!.querySelector('[aria-label="Draft"]'), "#random has a pencil");
    assert.equal(f.row("general")!.querySelector('[aria-label="Draft"]'), null, "the open channel has none");
    // Sending (or clearing) the draft takes the pencil away at once.
    bundle.mod.act(() => bundle.mod.persistDraft("c3", "", false));
    assert.equal(f.row("random")!.querySelector('[aria-label="Draft"]'), null, "the pencil goes with the draft");
  } finally {
    f.done();
    bundle.mod.forgetAllDrafts();
  }
});
