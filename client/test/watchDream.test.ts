import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mount = { render: (key?: string, active?: boolean, isHost?: boolean, onControl?: () => void) => void; unmount: () => void };
type Mod = { act: (callback: () => void) => void; mountWatchDream: (element: unknown) => Mount };
let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
const document = window.document;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountWatchDream.tsx"));
});
after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = bundle.mod.mountWatchDream(container);
  mounted.render();
  const toggle = () => container.querySelector<HTMLButtonElement>("[aria-pressed]")!;
  const click = () => bundle.mod.act(() => toggle().click());
  const cleanup = () => { mounted.unmount(); container.remove(); };
  return { container, mounted, toggle, click, cleanup };
}

test("Dream toggles preserve the iframe and never filter or inert its ancestors", () => {
  const f = setup();
  try {
    const iframe = f.container.querySelector("iframe");
    for (let i = 0; i < 6; i++) {
      f.click();
      assert.equal(f.toggle().getAttribute("aria-pressed"), String(i % 2 === 0));
      assert.equal(f.container.querySelector("iframe"), iframe);
      for (let el = iframe; el; el = el.parentElement) {
        assert.equal(el.classList.contains("kc-watch-surrounding--dream"), false);
        assert.equal(Boolean(el.inert), false);
      }
      assert.equal(Boolean(f.container.querySelector("aside")!.inert), i % 2 === 0);
    }
  } finally { f.cleanup(); }
});

test("Escape leaves Dream mode, restores focus and never stops playback", () => {
  const f = setup();
  try {
    let controls = 0;
    f.mounted.render("general", true, true, () => { controls++; });
    f.click();
    bundle.mod.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(document.activeElement, f.toggle());
    assert.equal(controls, 0);
    assert.ok(f.container.querySelector("iframe"));
  } finally { f.cleanup(); }
});

test("new sibling controls are isolated and prior inert state is preserved", async () => {
  const preexisting = document.createElement("div");
  preexisting.inert = true;
  document.body.append(preexisting);
  const f = setup();
  try {
    f.click();
    const added = document.createElement("button");
    f.container.querySelector("main")!.append(added);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(added.inert, true);
    assert.ok(added.classList.contains("kc-watch-surrounding--dream"));
    f.click();
    assert.equal(Boolean(added.inert), false);
    assert.equal(preexisting.inert, true);
  } finally { f.cleanup(); preexisting.remove(); }
});

test("navigation, remote end and unmount release background regions", () => {
  const f = setup();
  try {
    f.click();
    f.mounted.render("another");
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(f.container.querySelectorAll(".kc-watch-surrounding--dream").length, 0);
    f.click();
    f.mounted.render("another", false);
    assert.equal(document.querySelectorAll(".kc-watch-surrounding").length, 0);
    f.mounted.render("another");
    f.click();
  } finally { f.cleanup(); }
  assert.equal(document.querySelectorAll(".kc-watch-surrounding").length, 0);
});

test("guests get Dream mode without host controls; End exits before stopping", () => {
  const f = setup();
  try {
    f.mounted.render("general", true, false);
    assert.equal([...f.container.querySelectorAll("button")].some(button => button.textContent === "End"), false);
    f.click();
    assert.equal(f.toggle().getAttribute("aria-pressed"), "true");
    let controls = 0;
    f.mounted.render("general", true, true, () => { controls++; });
    const end = [...f.container.querySelectorAll("button")].find(button => button.textContent === "End")!;
    bundle.mod.act(() => end.click());
    assert.equal(controls, 1);
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
  } finally { f.cleanup(); }
});

test("Cinema uses fullscreen on the existing player and keeps its iframe through mode changes", async () => {
  const f = setup();
  let fullscreen: unknown = null;
  const descriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  const player = f.container.querySelector<HTMLElement>(".kc-watch")!;
  Object.assign(player, { requestFullscreen: async () => {
    fullscreen = player;
    document.dispatchEvent(new window.Event("fullscreenchange"));
  } });
  Object.assign(document, { exitFullscreen: async () => {
    fullscreen = null;
    document.dispatchEvent(new window.Event("fullscreenchange"));
  } });
  try {
    const iframe = f.container.querySelector("iframe");
    const cinemaButton = () => [...f.container.querySelectorAll("button")].find(button => button.textContent?.includes("Cinema"))!;
    f.click();
    bundle.mod.act(() => cinemaButton().click());
    assert.equal(fullscreen, player);
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(cinemaButton().getAttribute("aria-pressed"), "true");
    assert.equal(f.container.querySelector("iframe"), iframe);
    // A browser-owned exit (Escape) updates the UI without stopping or remounting.
    bundle.mod.act(() => { void document.exitFullscreen(); });
    assert.equal(cinemaButton().getAttribute("aria-pressed"), "false");
    assert.equal(f.container.querySelector("iframe"), iframe);
    bundle.mod.act(() => cinemaButton().click());
    f.mounted.render("another", false);
    assert.equal(fullscreen, null);
  } finally {
    f.cleanup();
    if (descriptor) Object.defineProperty(document, "fullscreenElement", descriptor);
    else Reflect.deleteProperty(document, "fullscreenElement");
    Reflect.deleteProperty(document, "exitFullscreen");
  }
});

test("a denied Cinema request leaves Dream mode and the iframe unchanged", async () => {
  const f = setup();
  try {
    const iframe = f.container.querySelector("iframe");
    const player = f.container.querySelector(".kc-watch")!;
    Object.assign(player, { requestFullscreen: () => Promise.reject(new Error("NotAllowedError")) });
    f.click();
    bundle.mod.act(() => [...f.container.querySelectorAll("button")].find(button => button.textContent === "Cinema")!.click());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.toggle().getAttribute("aria-pressed"), "true");
    assert.equal(f.container.querySelector("iframe"), iframe);
    assert.match(f.container.querySelector('[role="status"]')!.textContent!, /Fullscreen was not allowed/);
  } finally { f.cleanup(); }
});
