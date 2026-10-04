import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mount = { render: (volume?: number | null, isHost?: boolean, disabledReason?: string) => void; unmount: () => void };
type Mod = { act: (callback: () => void) => void; mountDreamGestures: (element: unknown, volume: (value: number) => void, toggle: () => void) => Mount };
let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountDreamGestures.tsx"));
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
  const volumes: number[] = [];
  let toggles = 0;
  const mount = bundle.mod.mountDreamGestures(container, value => volumes.push(value), () => toggles++);
  mount.render();
  const rail = container.querySelector('[role="slider"]')!;
  const surround = container.querySelector('button')!;
  const captures = new Set<number>();
  Object.assign(rail, { setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id), getBoundingClientRect: () => ({ height: 200 }) });
  const pointer = (element: typeof rail, type: string, y: number, pointerType = "touch", timeStamp = 100) => bundle.mod.act(() => {
    const event = new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, pointerType, clientX: 10, clientY: y });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    element.dispatchEvent(event);
  });
  return { container, rail, surround, captures, pointer, mount, volumes, toggles: () => toggles, cleanup: () => { mount.unmount(); container.remove(); } };
}
test("volume waits for player, keyboard is local and indicator is transient", async () => {
  const f = setup();
  try {
    assert.deepEqual(f.volumes, []);
    const key = () => bundle.mod.act(() => f.rail.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    key();
    assert.deepEqual(f.volumes, [40]);
    assert.equal(f.toggles(), 0);
    assert.equal(f.container.querySelector("span")!.hasAttribute("hidden"), false);
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(f.container.querySelector("span")!.hasAttribute("hidden"), true);
    f.mount.render(null);
    key();
    assert.equal(f.rail.getAttribute("aria-disabled"), "true");
    assert.deepEqual(f.volumes, [40]);
  } finally { f.cleanup(); }
});
test("volume drag captures pointer and cancellation releases it without toggling", () => {
  const f = setup();
  try {
    f.pointer(f.rail, "pointerdown", 200);
    assert.equal(f.captures.has(1), true);
    f.pointer(f.rail, "pointermove", 198);
    assert.deepEqual(f.volumes, []);
    f.pointer(f.rail, "pointermove", 150);
    assert.deepEqual(f.volumes, [60]);
    f.pointer(f.rail, "pointercancel", 150);
    assert.equal(f.captures.size, 0);
    f.pointer(f.rail, "pointermove", 100);
    assert.deepEqual(f.volumes, [60]);
    assert.equal(f.toggles(), 0);
  } finally { f.cleanup(); }
});
test("surround double tap toggles once; synthetic doubleclick is ignored", () => {
  const f = setup();
  try {
    f.pointer(f.surround, "pointerdown", 200, "touch", 100);
    f.pointer(f.surround, "pointerup", 200, "touch", 130);
    f.pointer(f.surround, "pointerdown", 200, "touch", 220);
    f.pointer(f.surround, "pointerup", 200, "touch", 250);
    assert.equal(f.toggles(), 1);
    bundle.mod.act(() => { const event = new window.MouseEvent("dblclick", { bubbles: true }); Object.defineProperty(event, "timeStamp", { value: 260 }); f.surround.dispatchEvent(event); });
    assert.equal(f.toggles(), 1);
  } finally { f.cleanup(); }
});
test("surround drag is not a tap and guests cannot toggle", () => {
  const f = setup();
  try {
    f.pointer(f.surround, "pointerdown", 200, "touch", 100);
    f.pointer(f.surround, "pointermove", 150, "touch", 110);
    f.pointer(f.surround, "pointerup", 200, "touch", 130);
    f.pointer(f.surround, "pointerdown", 200, "touch", 220);
    f.pointer(f.surround, "pointerup", 200, "touch", 250);
    assert.equal(f.toggles(), 0);
    f.mount.render(35, false);
    bundle.mod.act(() => f.surround.click());
    assert.equal(f.toggles(), 0);
    assert.equal(f.surround.disabled, true);
  } finally { f.cleanup(); }
});

test("unmount releases a captured drag", () => {
  const f = setup();
  f.pointer(f.rail, "pointerdown", 200);
  assert.equal(f.captures.size, 1);
  f.cleanup();
  assert.equal(f.captures.size, 0);
});
