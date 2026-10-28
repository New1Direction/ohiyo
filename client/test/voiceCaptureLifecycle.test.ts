import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mounted = { render: (active: boolean) => void; unmount: () => void };
type Mod = { act: (fn: () => void) => void; mountVoiceTab: (el: unknown, active?: boolean) => Mounted };
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<Mod>;
let micRequests = 0;
let fetches = 0;
let acquire: () => Promise<unknown> = async () => { throw new Error("denied"); };

class FakeContext {
  static created: FakeContext[] = [];
  static resume: () => Promise<void> = async () => {};
  closed = 0;
  constructor() { FakeContext.created.push(this); }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData() {} }; }
  resume() { return FakeContext.resume(); }
  async close() { this.closed++; }
}

before(async () => {
  const globals = {
    window, document, navigator: window.navigator, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => { fetches++; throw new Error("network forbidden"); },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => { micRequests++; return acquire(); } },
  });
  Object.defineProperty(window, "AudioContext", { configurable: true, writable: true, value: FakeContext });
  bundle = await bundleEntry<Mod>(join(fixtures, "mountVoiceCaptureLifecycle.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function stream() {
  let stopped = 0;
  return { getTracks: () => [{ stop: () => { stopped++; } }], stops: () => stopped };
}
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  bundle.mod.act(() => {});
}
function mount(active = false) {
  micRequests = 0;
  FakeContext.created = [];
  FakeContext.resume = async () => {};
  const el = document.createElement("div");
  document.body.append(el);
  const mounted = bundle.mod.mountVoiceTab(el, active);
  const button = (label: string) => {
    const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  return {
    el, button, render: mounted.render,
    click: (label: string) => bundle.mod.act(() => button(label).click()),
    done: () => { mounted.unmount(); el.remove(); },
  };
}

test("opening Voice settings never fetches or acquires a microphone, including remount and pagehide", async () => {
  window.localStorage.clear();
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = mount();
    try {
      bundle.mod.act(() => window.dispatchEvent(new window.Event("pagehide")));
      view.render(true);
      view.render(false);
      await settle();
      assert.equal(micRequests, 0);
      assert.equal(fetches, 0);
      assert.equal(window.localStorage.length, 0);
      assert.equal(FakeContext.created.length, 0);
    } finally { view.done(); }
  }
});

test("calls disable separate captures, without resuming when a call ends", async () => {
  const view = mount(true);
  try {
    assert.equal(view.button("Check my mic").disabled, true);
    view.click("Check my mic");
    assert.match(view.el.textContent!, /Leave your call before checking/);
    view.render(false);
    await settle();
    assert.equal(micRequests, 0);
    assert.equal(view.button("Check my mic").disabled, false);
  } finally { view.done(); }
});

for (const interruption of ["stop", "unmount", "pagehide", "call"] as const) {
  test(`pending mic permission is cancelled on ${interruption}; late stream is stopped`, async () => {
    const pending = deferred<unknown>();
    acquire = () => pending.promise;
    const captured = stream();
    const view = mount();
    let unmounted = false;
    try {
      view.click("Check my mic");
      assert.equal(micRequests, 1);
      if (interruption === "stop") view.click("Stop checking");
      if (interruption === "unmount") { view.done(); unmounted = true; }
      if (interruption === "pagehide") bundle.mod.act(() => window.dispatchEvent(new window.Event("pagehide")));
      if (interruption === "call") view.render(true);
      pending.resolve(captured);
      await settle();
      assert.equal(captured.stops(), 1);
      assert.equal(FakeContext.created.length, 0);
      if (!unmounted) {
        view.render(false);
        await settle();
        assert.equal(micRequests, 1, "must not automatically reacquire");
      }
    } finally { if (!unmounted) view.done(); }
  });
}

test("rapid stop/start discards old permission result without killing the new capture", async () => {
  const old = deferred<unknown>();
  const current = stream();
  const stale = stream();
  const view = mount();
  acquire = () => micRequests === 1 ? old.promise : Promise.resolve(current);
  try {
    view.click("Check my mic");
    view.click("Stop checking");
    view.click("Check my mic");
    await settle();
    old.resolve(stale);
    await settle();
    assert.equal(stale.stops(), 1);
    assert.equal(current.stops(), 0);
    assert.equal(FakeContext.created.length, 1);
    view.click("Stop checking");
    assert.equal(current.stops(), 1);
    assert.equal(FakeContext.created[0].closed, 1);
  } finally { view.done(); }
});

test("pagehide stops a live meter immediately, even while AudioContext resume is pending", async () => {
  const captured = stream();
  acquire = async () => captured;
  const view = mount();
  const resume = deferred<void>();
  FakeContext.resume = () => resume.promise;
  try {
    view.click("Check my mic");
    await settle();
    bundle.mod.act(() => window.dispatchEvent(new window.Event("pagehide")));
    assert.equal(captured.stops(), 1);
    assert.equal(FakeContext.created[0].closed, 1);
    resume.resolve();
    await settle();
    assert.equal(view.button("Check my mic").disabled, false);
    assert.equal(view.el.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"), "-100");
  } finally { view.done(); }
});

test("audio setup error releases capture and displays a safe error", async () => {
  const captured = stream();
  acquire = async () => captured;
  const view = mount();
  FakeContext.resume = async () => { throw new Error("private details must not be displayed"); };
  try {
    view.click("Check my mic");
    await settle();
    assert.equal(captured.stops(), 1);
    assert.equal(FakeContext.created[0].closed, 1);
    assert.match(view.el.querySelector('[role="alert"]')?.textContent ?? "", /couldn't use your microphone/);
    assert.doesNotMatch(view.el.textContent!, /private details/);
    assert.equal(fetches, 0);
  } finally { view.done(); }
});
