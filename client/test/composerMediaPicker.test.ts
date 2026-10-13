// The composer's GIF tab. It searched Tenor straight from the browser, and Google shut that API
// down on 30 June 2026, so the tab was broken. GIF search now goes through the home's server to
// KLIPY; a home without a KLIPY key shows no GIFs tab at all rather than a broken one, and the
// search box says "Search KLIPY" as KLIPY's attribution rules require.
//   node --experimental-strip-types --test test/composerMediaPicker.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Gif = { id: string; title: string; url: string; preview: string };
type Mod = {
  act: (callback: () => void) => void;
  mountComposerMediaPicker: (
    el: unknown,
    opts: { gifsAvailable: boolean; tab: "emoji" | "gif"; gifResults?: Gif[] },
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountComposerMediaPicker.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const GIF = {
  id: "g1",
  title: "Happy dance",
  url: "https://static.klipy.com/ii/abc/14/af/dance.gif",
  preview: "https://static.klipy.com/ii/abc/14/af/dance-sm.webp",
};

function mount(opts: { gifsAvailable: boolean; tab: "emoji" | "gif"; gifResults?: Gif[] }) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountComposerMediaPicker(container, opts);
  return {
    ...f,
    container,
    text: () => (container.textContent ?? "").replace(/\s+/g, " "),
    buttons: () => [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()),
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("a home without GIF search shows no GIFs tab, so nothing broken is on offer", () => {
  const f = mount({ gifsAvailable: false, tab: "emoji" });
  try {
    assert.ok(!f.buttons().includes("GIFs"), f.buttons().join(" | "));
    assert.ok(f.buttons().includes("Emoji") || f.text().includes("emoji"), "the emoji picker still works");
  } finally {
    f.done();
  }
});

test("with GIF search, the box says Search KLIPY and the tab credits KLIPY, not Tenor", () => {
  const f = mount({ gifsAvailable: true, tab: "gif", gifResults: [GIF] });
  try {
    assert.ok(f.buttons().includes("GIFs"));
    const box = [...f.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === "Search KLIPY");
    assert.ok(box, "the search box's placeholder is Search KLIPY");
    assert.ok(f.text().includes("Powered by KLIPY"), f.text());
    assert.ok(!/tenor/i.test(f.container.innerHTML), "no Tenor left");
  } finally {
    f.done();
  }
});

test("picking a GIF sends its link", () => {
  const f = mount({ gifsAvailable: true, tab: "gif", gifResults: [GIF] });
  try {
    const pick = [...f.container.querySelectorAll("button")].find((b) => b.getAttribute("title") === "Happy dance");
    assert.ok(pick, "the result is a button named for the GIF");
    bundle.mod.act(() => (pick as unknown as { click(): void }).click());
    assert.ok(f.calls.includes(`send ${GIF.url}`), f.calls.join(" | "));
  } finally {
    f.done();
  }
});
