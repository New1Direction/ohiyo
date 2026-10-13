// Getting around on a phone: the tab bar at the foot of the drawer, the slim call bar a
// minimised call becomes, and the member list as a panel from the right.
//   node --experimental-strip-types --test test/phoneNav.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type NavMod = {
  act: (callback: () => void) => void;
  mountPhoneTabBar: (el: unknown, props: { active: string; dmUnread: number; mentionCount: number }) => { picked: string[]; unmount: () => void };
  mountSideModal: (el: unknown) => { unmount: () => void };
};
type CallMod = {
  act: (callback: () => void) => void;
  mountCallOverlay: (
    el: unknown,
    opts: { self: { muted: boolean; deafened: boolean }; peers: { user_id: string; name: string; muted: boolean }[] },
  ) => { calls: string[]; unmount: () => void };
};

let nav: Bundle<NavMod>;
let call: Bundle<CallMod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let phone = true;

before(async () => {
  // Media queries: a phone-sized screen unless a test says otherwise.
  window.matchMedia = ((query: string) => ({
    matches: phone && /max-width/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as never;
  const globals = {
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLMediaElement: window.HTMLMediaElement,
    Node: window.Node,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  nav = await bundleEntry<NavMod>(join(fixtures, "mountPhoneNav.tsx"));
  call = await bundleEntry<CallMod>(join(fixtures, "mountCallOverlay.tsx"));
});

after(async () => {
  await nav?.cleanup();
  await call?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type El = { textContent: string | null; getAttribute(name: string): string | null; click(): void; className: string };
const buttons = () => [...document.body.querySelectorAll("button")] as unknown as El[];
const named = (label: string) => buttons().find((b) => (b.getAttribute("aria-label") ?? (b.textContent ?? "").trim()) === label);

function holder() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

test("the phone tab bar has Home, Messages, Mentions and You, and marks the one you're on", () => {
  const el = holder();
  const f = nav.mod.mountPhoneTabBar(el, { active: "messages", dmUnread: 0, mentionCount: 0 });
  try {
    const bar = el.querySelector('nav[aria-label="Main"]');
    assert.ok(bar, "a nav landmark named Main");
    const labels = [...bar!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(labels, ["Home", "Messages", "Mentions", "You"]);
    const current = [...bar!.querySelectorAll("button")].filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(current, ["Messages"]);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("unread messages and mentions show as numbers on their tabs", () => {
  const el = holder();
  const f = nav.mod.mountPhoneTabBar(el, { active: "home", dmUnread: 3, mentionCount: 12 });
  try {
    const labels = [...el.querySelectorAll("nav button")].map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(labels, ["Home", "Messages, 3 unread", "Mentions, 12", "You"]);
    const badges = [...el.querySelectorAll(".kc-phone-tab-badge")].map((b) => (b.textContent ?? "").trim());
    assert.deepEqual(badges, ["3", "9+"]);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("tapping a tab says which one", () => {
  const el = holder();
  const f = nav.mod.mountPhoneTabBar(el, { active: "home", dmUnread: 0, mentionCount: 0 });
  try {
    nav.mod.act(() => (el.querySelector('button[aria-label="Messages"]') as unknown as El).click());
    nav.mod.act(() => (el.querySelector('button[aria-label="You"]') as unknown as El).click());
    assert.deepEqual(f.picked, ["messages", "you"]);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("on a phone a minimised call is a slim bar with mute, deafen and hang up one tap away", () => {
  phone = true;
  const el = holder();
  const f = call.mod.mountCallOverlay(el, { self: { muted: false, deafened: false }, peers: [{ user_id: "b", name: "Ben", muted: false }] });
  try {
    call.mod.act(() => named("Minimize")!.click());
    const bar = document.body.querySelector(".kc-call-overlay--bar");
    assert.ok(bar, "the minimised call is the slim bar");
    const labels = [...bar!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim());
    for (const want of ["Open call", "Mute", "Deafen", "Leave call"]) assert.ok(labels.includes(want), `${want} missing: ${labels.join(", ")}`);
    assert.ok(!labels.includes("Share screen"), "the bar keeps to the essentials");
    call.mod.act(() => (bar!.querySelector('button[aria-label="Leave call"]') as unknown as El).click());
    assert.deepEqual(f.calls, ["hangUp"]);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("on a computer a minimised call keeps the floating card", () => {
  phone = false;
  const el = holder();
  const f = call.mod.mountCallOverlay(el, { self: { muted: false, deafened: false }, peers: [{ user_id: "b", name: "Ben", muted: false }] });
  try {
    call.mod.act(() => named("Minimize")!.click());
    assert.equal(document.body.querySelector(".kc-call-overlay--bar"), null);
    assert.ok(named("Open"), "the card's Open button");
  } finally {
    f.unmount();
    el.remove();
    phone = true;
  }
});

test("the member list's dialog can be a panel from the right", () => {
  const el = holder();
  const f = nav.mod.mountSideModal(el);
  try {
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog, "a dialog");
    assert.ok(dialog!.className.includes("kc-modal--side"), `dialog classes: ${dialog!.className}`);
    assert.ok(document.body.querySelector(".kc-backdrop--side"), "its backdrop is the side kind");
  } finally {
    f.unmount();
    el.remove();
  }
});
