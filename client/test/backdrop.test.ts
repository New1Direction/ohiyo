import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures } from "./fixtures/bundle.ts";

test("background choices cycle, survive remounts, and work without local storage", async () => {
  const window = new Window({ url: "http://localhost/burrow" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, ResizeObserver: window.ResizeObserver, cancelAnimationFrame: window.cancelAnimationFrame.bind(window) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown) => () => void }>(join(fixtures, "backdrop.tsx"));
  const container = window.document.createElement("main");
  window.document.body.append(container);
  let unmount = () => {};
  const label = () => container.querySelector("button")!.getAttribute("aria-label")!;
  const next = () => bundle.mod.act(() => container.querySelector("button")!.click());
  try {
    window.localStorage.setItem("burrow:backdrop", "old-or-invalid-choice");
    unmount = bundle.mod.mount(container);
    assert.match(label(), /Change background\. Ember\./);
    for (const name of ["Neural bloom", "Rainbow terrain", "Dot mandala", "Particle orbit", "ASCII orbit", "Paper · dither swirl", "Paper · dotted aurora", "Quiet · no backdrop", "Ember"]) {
      next();
      assert.ok(label().startsWith(`Change background. ${name}.`), label());
      assert.equal(container.querySelector('[role="status"]')!.textContent, `Background: ${name}`);
    }
    next(); next();
    unmount(); unmount = bundle.mod.mount(container);
    assert.match(label(), /Rainbow terrain\./);
    unmount();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    unmount = bundle.mod.mount(container);
    assert.match(label(), /Ember\./);
    next();
    assert.match(label(), /Neural bloom\./);
  } finally {
    unmount(); await bundle.cleanup(); await window.happyDOM.abort();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
