// Events: a month calendar (today marked, arrow keys move between days) with an agenda
// view, an event card with Interested / Going / Can't go and the people going, and the
// "Event starting" banner with Join voice.
//   node --experimental-strip-types --test test/eventsRender.test.ts

process.env.TZ = "UTC";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Calls = string[];
type Mounted = { calls: Calls; unmount: () => void };
type Mod = {
  act: (callback: () => void) => void;
  mountEventCalendar: (el: unknown, opts: { now: number; view?: "month" | "agenda" }) => Mounted;
  mountEventCard: (el: unknown, opts: { variant: "voice" | "cancelled"; canManage: boolean }) => Mounted;
  mountEventBanner: (el: unknown, opts: { phase: "soon" | "start" | "cancelled"; voice: boolean }) => Mounted;
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountEvents.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type El = {
  textContent: string | null;
  getAttribute(name: string): string | null;
  click(): void;
  focus(): void;
  querySelector(sel: string): El | null;
};

const NOW = Date.UTC(2026, 9, 12, 12, 0) / 1000; // Monday 12 October 2026, noon

function container() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

const q = (root: { querySelector(s: string): unknown }, sel: string) => root.querySelector(sel) as El | null;
const all = (root: { querySelectorAll(s: string): Iterable<unknown> }, sel: string) =>
  [...root.querySelectorAll(sel)] as unknown as El[];
const text = (el: El | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (root: { querySelectorAll(s: string): Iterable<unknown> }, label: string) =>
  all(root, "button").find((b) => text(b).startsWith(label) || b.getAttribute("aria-label") === label);

function press(key: string) {
  const target = document.activeElement ?? document.body;
  bundle.mod.act(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

// What has focus, as text (never compare DOM nodes in an assertion).
const focusedDay = () => (document.activeElement as unknown as El | null)?.getAttribute("data-day") ?? "nothing";

test("the month grid marks today and puts each event on its day", () => {
  const el = container();
  const f = bundle.mod.mountEventCalendar(el, { now: NOW, view: "month" });
  try {
    const grid = q(el, '[role="grid"]');
    assert.ok(grid, "a grid");
    assert.equal(grid.getAttribute("aria-label"), "October 2026");
    const today = q(el, '[aria-current="date"]');
    assert.equal(today?.getAttribute("data-day"), "2026-10-12");
    assert.match(text(q(el, '[data-day="2026-10-20"]')), /Game night/);
    assert.match(text(q(el, '[data-day="2026-10-12"]')), /Picnic/);
    assert.doesNotMatch(text(q(el, '[data-day="2026-10-13"]')), /Game night|Picnic/);

    bundle.mod.act(() => button(q(el, '[data-day="2026-10-20"]')!, "Game night")!.click());
    assert.deepEqual(f.calls, ["open ev-game"]);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("arrow keys and Page Down move between days and months", () => {
  const el = container();
  const f = bundle.mod.mountEventCalendar(el, { now: NOW, view: "month" });
  try {
    const today = q(el, '[aria-current="date"]')!;
    assert.equal(today.getAttribute("tabindex"), "0", "today is the one tab stop");
    bundle.mod.act(() => today.focus());
    press("ArrowRight");
    assert.equal(focusedDay(), "2026-10-13");
    press("ArrowDown");
    assert.equal(focusedDay(), "2026-10-20");
    press("ArrowLeft");
    press("ArrowUp");
    assert.equal(focusedDay(), "2026-10-12");
    press("PageDown");
    assert.equal(q(el, '[role="grid"]')?.getAttribute("aria-label"), "November 2026");
    assert.equal(focusedDay(), "2026-11-12");
  } finally {
    f.unmount();
    el.remove();
  }
});

test("the agenda lists what's coming by day, starting with today", () => {
  const el = container();
  const f = bundle.mod.mountEventCalendar(el, { now: NOW, view: "month" });
  try {
    bundle.mod.act(() => button(el, "Agenda")!.click());
    assert.equal(button(el, "Agenda")!.getAttribute("aria-pressed"), "true");
    assert.equal(q(el, '[role="grid"]'), null, "the grid gives way to the list");
    const body = text(el as unknown as El);
    assert.ok(body.indexOf("Today") < body.indexOf("Picnic"), "today first");
    assert.ok(body.indexOf("Picnic") < body.indexOf("Game night"), "in order");
  } finally {
    f.unmount();
    el.remove();
  }
});

test("a phone opens on the agenda", () => {
  const el = container();
  const f = bundle.mod.mountEventCalendar(el, { now: NOW, view: "agenda" });
  try {
    assert.equal(q(el, '[role="grid"]'), null);
    assert.match(text(el as unknown as El), /Picnic/);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("the card answers Interested, Going or Can't go, with counts and who's going", () => {
  const el = container();
  const f = bundle.mod.mountEventCard(el, { variant: "voice", canManage: false });
  try {
    const group = q(el, '[role="group"][aria-label="Your answer"]')!;
    assert.ok(group, "an answer group");
    const interested = button(group, "Interested")!;
    const going = button(group, "Going")!;
    const cant = button(group, "Can't go")!;
    assert.equal(interested.getAttribute("aria-pressed"), "true");
    assert.equal(going.getAttribute("aria-pressed"), "false");
    assert.equal(cant.getAttribute("aria-pressed"), "false");
    assert.match(text(interested), /2/);
    assert.match(text(going), /1/);
    assert.match(text(el as unknown as El), /Bea/, "who's going");
    assert.match(text(el as unknown as El), /General/, "the voice channel");

    bundle.mod.act(() => going.click());
    bundle.mod.act(() => interested.click());
    bundle.mod.act(() => button(el, "Join voice")!.click());
    bundle.mod.act(() => button(el, "Add to calendar")!.click());
    assert.deepEqual(f.calls, ["rsvp going", "rsvp none", "join c2", "ics"]);
    assert.equal(button(el, "Edit"), undefined, "only the host or a manager edits");
    assert.equal(button(el, "Cancel event"), undefined);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("the host can edit and cancel; a cancelled event takes no answers", () => {
  let el = container();
  let f = bundle.mod.mountEventCard(el, { variant: "voice", canManage: true });
  try {
    bundle.mod.act(() => button(el, "Edit")!.click());
    bundle.mod.act(() => button(el, "Cancel event")!.click());
    assert.deepEqual(f.calls, ["edit", "cancel"]);
  } finally {
    f.unmount();
    el.remove();
  }
  el = container();
  f = bundle.mod.mountEventCard(el, { variant: "cancelled", canManage: true });
  try {
    assert.match(text(el as unknown as El), /Cancelled/);
    assert.equal(q(el, '[role="group"][aria-label="Your answer"]'), null);
    assert.equal(button(el, "Join voice"), undefined);
    assert.equal(button(el, "Cancel event"), undefined);
    assert.ok(button(el, "Delete"), "a cancelled event can be cleared away");
  } finally {
    f.unmount();
    el.remove();
  }
});

test("the banner says when an event is starting and offers to join its voice channel", () => {
  let el = container();
  let f = bundle.mod.mountEventBanner(el, { phase: "start", voice: true });
  try {
    assert.ok(q(el, '[role="status"]'), "announced politely");
    assert.match(text(el as unknown as El), /Event starting/);
    assert.match(text(el as unknown as El), /Game night/);
    bundle.mod.act(() => button(el, "Join voice")!.click());
    bundle.mod.act(() => button(el, "Dismiss")!.click());
    assert.deepEqual(f.calls, ["join c2", "dismiss"]);
  } finally {
    f.unmount();
    el.remove();
  }
  el = container();
  f = bundle.mod.mountEventBanner(el, { phase: "soon", voice: false });
  try {
    assert.match(text(el as unknown as El), /Starting soon/);
    assert.equal(button(el, "Join voice"), undefined);
  } finally {
    f.unmount();
    el.remove();
  }
});
