// The search sheet: typing suggests filters (people for from:, channels for in:, kinds for
// has:), picked filters show as chips, results come grouped by channel with the matching
// words marked, and Jump goes to the message itself.
//   node --experimental-strip-types --test test/searchModal.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Hit = { id: string; channel_id: string; thread_parent_id?: string | null };
type Mod = {
  act: (callback: () => void) => void;
  mountSearchModal: (el: unknown) => { queries: string[]; jumps: Hit[]; closed: () => number; unmount: () => void };
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountSearchModal.tsx"), [
    { find: /^\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open() {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountSearchModal(container);
  const act = bundle.mod.act;
  const box = () => container.querySelector('input[aria-label="Search messages"]') as unknown as HTMLInputElement;
  const type = (value: string) =>
    act(() => {
      const input = box();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  const key = (k: string) =>
    act(() => {
      box().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event);
    });
  const options = () => [...container.querySelectorAll('[role="option"]')].map((o) => (o.textContent ?? "").trim());
  return {
    ...f,
    container,
    act,
    box,
    type,
    key,
    options,
    text: () => container.textContent ?? "",
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("typing from: offers the space's people, and picking one makes a chip", async () => {
  const f = open();
  try {
    f.type("from:");
    const offered = f.options();
    assert.equal(offered.length, 2, `two people offered, got ${JSON.stringify(offered)}`);
    assert.match(offered[0], /Alice Doe/);
    assert.match(offered[0], /alice/);
    assert.equal(f.box().getAttribute("aria-expanded"), "true", "the box says its list is open");
    f.key("ArrowDown");
    f.key("Enter");
    assert.equal(f.box().value, "from:bob ", "the second person replaced the word");
    const chips = [...f.container.querySelectorAll(".kc-search-chip")].map((c) => (c.textContent ?? "").trim());
    assert.ok(chips.some((c) => /from/i.test(c) && /bob/.test(c)), `a chip for the filter, got ${JSON.stringify(chips)}`);
  } finally {
    f.done();
  }
});

test("in: offers channels and has: offers its kinds", async () => {
  const f = open();
  try {
    f.type("in:ra");
    assert.deepEqual(f.options().map((o) => o.replace(/\s+/g, " ")), ["#random"]);
    f.type("has:");
    assert.equal(f.options().length, 5);
    f.key("Escape");
    assert.equal(f.options().length, 0, "Escape closes the suggestions, not the sheet");
    assert.equal(f.closed(), 0);
  } finally {
    f.done();
  }
});

test("results come grouped by channel, threads under theirs, with the words marked", async () => {
  const f = open();
  try {
    f.type("deploy");
    await wait(450);
    assert.deepEqual(f.queries.at(-1), "deploy");
    const headings = [...f.container.querySelectorAll(".kc-search-group__title")].map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim());
    assert.deepEqual(headings, ["#general", "Rollout in #general", "#random"]);
    const marked = [...f.container.querySelectorAll("mark")].map((m) => m.textContent);
    assert.deepEqual(marked, ["Deploy", "deploy", "deploy"]);
    assert.match(f.text(), /3 results/);
    assert.match(f.text(), /Alice Doe/);
  } finally {
    f.done();
  }
});

test("Jump goes to the message itself, in a thread when it's in one", async () => {
  const f = open();
  try {
    f.type("deploy");
    await wait(450);
    const jumps = [...f.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Jump");
    assert.equal(jumps.length, 3);
    f.act(() => (jumps[1] as unknown as HTMLButtonElement).click());
    assert.deepEqual(f.jumps, [{ id: "m2", channel_id: "t1", thread_parent_id: "c1" }]);
    assert.equal(f.closed(), 1, "jumping closes the sheet");
  } finally {
    f.done();
  }
});

test("a capped total, nothing found, and a failed search each say so plainly", async () => {
  const f = open();
  try {
    f.type("many");
    await wait(450);
    assert.match(f.text(), /100\+ results/);
    f.type("nothing");
    await wait(450);
    assert.match(f.text(), /No messages match/);
    f.type("broken");
    await wait(450);
    assert.match(f.text(), /Search couldn.t load/);
  } finally {
    f.done();
  }
});
