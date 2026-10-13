// Deafen in the call controls, how deafened people show, the push to talk indicator, and the
// Voice & video settings tab (input mode, push to talk key, input sensitivity).
//   node --experimental-strip-types --test test/voiceControlsUi.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type CallMod = {
  act: (callback: () => void) => void;
  mountCallOverlay: (
    el: unknown,
    opts: {
      self: { muted: boolean; deafened: boolean };
      peers: { user_id: string; name: string; muted: boolean; deafened?: boolean }[];
      pushToTalk?: { keyLabel: string; transmitting: boolean } | null;
    },
  ) => { calls: string[]; unmount: () => void };
};
type TabMod = {
  act: (callback: () => void) => void;
  mountVoiceTab: (el: unknown) => { unmount: () => void };
};

let callBundle: Bundle<CallMod>;
let tabBundle: Bundle<TabMod>;
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
    HTMLMediaElement: window.HTMLMediaElement,
    Node: window.Node,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  callBundle = await bundleEntry<CallMod>(join(fixtures, "mountCallOverlay.tsx"));
  tabBundle = await bundleEntry<TabMod>(join(fixtures, "mountVoiceTab.tsx"));
});

after(async () => {
  await callBundle?.cleanup();
  await tabBundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type El = { textContent: string | null; getAttribute(name: string): string | null; click(): void };

const buttonLabels = () =>
  [...document.body.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim());
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label) as unknown as El | undefined;

function call(opts: Parameters<CallMod["mountCallOverlay"]>[1]) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = callBundle.mod.mountCallOverlay(container, opts);
  return {
    ...f,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("the call controls have a Deafen button beside Mute", () => {
  const f = call({ self: { muted: false, deafened: false }, peers: [{ user_id: "b", name: "Ben", muted: false }] });
  try {
    const labels = buttonLabels();
    assert.ok(labels.includes("Mute"), labels.join(", "));
    assert.ok(labels.includes("Deafen"), `no Deafen button: ${labels.join(", ")}`);
    assert.ok(labels.indexOf("Deafen") === labels.indexOf("Mute") + 1, "Deafen sits right after Mute");
    callBundle.mod.act(() => button("Deafen")!.click());
    assert.deepEqual(f.calls, ["toggleDeafen"]);
  } finally {
    f.done();
  }
});

test("while deafened the buttons say Undeafen and Unmute, and the call's sound is off", () => {
  const f = call({ self: { muted: true, deafened: true }, peers: [{ user_id: "b", name: "Ben", muted: false }] });
  try {
    const labels = buttonLabels();
    assert.ok(labels.includes("Undeafen"), labels.join(", "));
    assert.ok(labels.includes("Unmute"), labels.join(", "));
    const audio = [...document.body.querySelectorAll("audio")];
    assert.ok(audio.length > 0, "a sink plays Ben's audio");
    assert.ok(audio.every((a) => (a as unknown as { muted: boolean }).muted), "every remote sink is silent while deafened");
  } finally {
    f.done();
  }
  const g = call({ self: { muted: false, deafened: false }, peers: [{ user_id: "b", name: "Ben", muted: false }] });
  try {
    const audio = [...document.body.querySelectorAll("audio")];
    assert.ok(audio.every((a) => !(a as unknown as { muted: boolean }).muted), "and plays again once undeafened");
  } finally {
    g.done();
  }
});

test("people who are deafened show as Deafened, not just muted", () => {
  const f = call({
    self: { muted: true, deafened: true },
    peers: [
      { user_id: "b", name: "Ben", muted: true, deafened: true },
      { user_id: "c", name: "Cat", muted: true, deafened: false },
    ],
  });
  try {
    const text = document.body.textContent ?? "";
    const deafenedCount = text.split("Deafened").length - 1;
    assert.equal(deafenedCount, 2, `Ben and you show as Deafened: ${text}`);
    assert.ok(text.includes("Muted"), "Cat is only muted");
  } finally {
    f.done();
  }
});

test("push to talk says which key to hold, and when you're talking", () => {
  const f = call({
    self: { muted: false, deafened: false },
    peers: [{ user_id: "b", name: "Ben", muted: false }],
    pushToTalk: { keyLabel: "V", transmitting: false },
  });
  try {
    assert.ok((document.body.textContent ?? "").includes("Hold V to talk"));
  } finally {
    f.done();
  }
  const g = call({
    self: { muted: false, deafened: false },
    peers: [{ user_id: "b", name: "Ben", muted: false }],
    pushToTalk: { keyLabel: "V", transmitting: true },
  });
  try {
    assert.ok((document.body.textContent ?? "").includes("Talking"));
  } finally {
    g.done();
  }
});

// ── Voice & video settings ────────────────────────────────────────────────────

function tab() {
  const container = document.createElement("div");
  document.body.append(container);
  const f = tabBundle.mod.mountVoiceTab(container);
  return {
    container,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

const saved = () => JSON.parse(window.localStorage.getItem("ohiyo.voicePrefs.v1") ?? "null");

test("settings: choose push to talk and record its key", () => {
  window.localStorage.clear();
  const f = tab();
  try {
    const ptt = f.container.querySelector('input[type="radio"][value="ptt"]') as unknown as El | null;
    const voice = f.container.querySelector('input[type="radio"][value="voice"]') as unknown as { checked: boolean } | null;
    assert.ok(ptt && voice, "two input modes");
    assert.equal(voice.checked, true, "voice activity by default");
    assert.ok((f.container.textContent ?? "").includes("while Ohiyo is the window you're using"), "says where push to talk works");

    tabBundle.mod.act(() => ptt.click());
    assert.equal(saved()?.inputMode, "ptt");
    const setKey = [...f.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Set a key")) as unknown as El | undefined;
    assert.ok(setKey, "no key yet: Set a key");
    tabBundle.mod.act(() => setKey.click());
    assert.ok((f.container.textContent ?? "").includes("Press a key"));
    tabBundle.mod.act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "v", code: "KeyV", bubbles: true }));
    });
    assert.equal(saved()?.pttKey, "KeyV");
    assert.ok((f.container.textContent ?? "").includes("V"));
    assert.ok(!(f.container.textContent ?? "").includes("Press a key"));
  } finally {
    f.done();
  }
});

test("settings: Escape cancels recording a key", () => {
  window.localStorage.setItem("ohiyo.voicePrefs.v1", JSON.stringify({ inputMode: "ptt", pttKey: "KeyB" }));
  const f = tab();
  try {
    const change = [...f.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Change")) as unknown as El | undefined;
    assert.ok(change, "a saved key can be changed");
    tabBundle.mod.act(() => change.click());
    tabBundle.mod.act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    });
    assert.equal(saved()?.pttKey, "KeyB", "Escape keeps the old key");
    assert.ok(!(f.container.textContent ?? "").includes("Press a key"));
  } finally {
    f.done();
  }
});

test("settings: turning off automatic sensitivity shows the sensitivity slider", () => {
  window.localStorage.clear();
  const f = tab();
  try {
    const auto = [...f.container.querySelectorAll('input[type="checkbox"]')].find((el) =>
      (el.closest("label")?.textContent ?? "").includes("Automatically determine input sensitivity"),
    ) as unknown as (El & { checked: boolean }) | undefined;
    assert.ok(auto, "an Automatically determine switch");
    assert.equal(auto.checked, true);
    assert.equal(f.container.querySelector('input[type="range"][aria-label="Input sensitivity"]'), null, "no slider while automatic");
    tabBundle.mod.act(() => auto.click());
    assert.equal(saved()?.autoSensitivity, false);
    assert.ok(f.container.querySelector('input[type="range"][aria-label="Input sensitivity"]'), "the slider appears");
  } finally {
    f.done();
  }
});
