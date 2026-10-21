import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Props = { text: string; activity: "ready" | "working" | "needs-you" | "stopped" | "error"; revision: number };
type Mod = { act: (callback: () => void) => void; mount: (el: unknown, props: Props) => { update: (next: Props) => void; unmount: () => void } };
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<Mod>;
class Utterance {
  text: string;
  constructor(text: string) { this.text = text; }
  voice: unknown;
  lang = "";
  onstart?: () => void;
  onend?: () => void;
  onerror?: () => void;
}
const remote = { name: "Remote default", lang: "en-US", default: true, localService: false };
const local = { name: "On device", lang: "en-GB", default: false, localService: true };
let voices = [remote, local];
let playing: Utterance | null = null;
const speech = Object.assign(new window.EventTarget(), {
  getVoices: () => voices,
  speak: (next: Utterance) => { playing = next; },
  cancel: () => { playing = null; },
});
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.assign(window, { speechSynthesis: speech, SpeechSynthesisUtterance: Utterance });
  bundle = await bundleEntry<Mod>(join(fixtures, "kikkaReply.tsx"));
});
after(async () => {
  await bundle?.cleanup(); await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  }
});
async function setup() {
  voices = [remote, local]; playing = null;
  const container = document.createElement("div"); document.body.append(container);
  const props: Props = { text: "Your comparison is saved.", activity: "ready", revision: 1 };
  const view = bundle.mod.mount(container, props);
  await new Promise<void>(resolve => setImmediate(resolve));
  const button = () => container.querySelector<HTMLButtonElement>("button")!;
  return { container, props, ...view, button, click: () => bundle.mod.act(() => button().click()), cleanup: () => { view.unmount(); container.remove(); } };
}

test("speech is explicit, on-device only, and stopping or typing leaves the reply intact", async () => {
  const f = await setup();
  try {
    assert.equal(playing, null, "opening a reply never speaks automatically");
    f.click();
    const first = playing!;
    assert.equal(first.text, f.props.text);
    assert.equal(first.voice, local, "remote default must not win over a local voice");
    assert.match(f.container.textContent, /Getting voice ready/);
    bundle.mod.act(() => first.onstart!());
    assert.match(f.container.textContent, /Reading aloud/);
    for (const key of ["Enter", " "]) {
      bundle.mod.act(() => f.button().dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })));
      assert.match(f.button().textContent, /Stop talking/, "keyboard activation must not turn Stop into Read before the click");
      f.click(); assert.equal(playing, null);
      f.click(); assert.ok(playing);
    }
    f.click();
    assert.equal(playing, null); assert.match(f.container.textContent, /Your comparison is saved/);
    f.click();
    const second = playing!;
    bundle.mod.act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", bubbles: true })));
    assert.equal(playing, null); assert.match(f.button().textContent, /Read aloud/);
    f.click();
    bundle.mod.act(() => { first.onend!(); second.onerror!(); });
    assert.match(f.button().textContent, /Stop talking/, "late events cannot stop a newer reply");
    assert.equal(f.container.querySelector('[role="alert"]'), null);
  } finally { f.cleanup(); }
});

test("updates and leaving stop old speech without speaking the new reply; failures keep text usable", async () => {
  const f = await setup();
  try {
    f.click();
    assert.ok(playing);
    f.update({ ...f.props, activity: "working", revision: 2, text: "Saving your change…" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(playing, null); assert.equal(f.button().disabled, true);
    assert.match(f.container.textContent, /Working on this/);
    assert.equal(f.container.querySelector(".kikka-working-dots")?.getAttribute("aria-hidden"), "true");
    assert.doesNotMatch(f.container.textContent, /is typing|Read by Kikka/);
    f.update({ ...f.props, activity: "needs-you", revision: 3 });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(playing, null); assert.match(f.container.textContent, /Needs you/);
    assert.equal(f.container.querySelector(".kikka-working-dots"), null, "paused work must not look like an active reply");
    f.update({ ...f.props, activity: "error", revision: 4 });
    assert.match(f.container.querySelector(".kikka-activity")!.textContent, /Needs attention/);
    assert.equal(f.container.querySelector(".kikka-working-dots"), null);
    f.click();
    bundle.mod.act(() => playing!.onerror!());
    assert.equal(playing, null); assert.match(f.container.querySelector('[role="alert"]')!.textContent, /reply is still here/);
    f.click();
    bundle.mod.act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(playing, null);
    f.click(); f.unmount();
    assert.equal(playing, null);
  } finally { f.container.remove(); }
});

test("unavailable, delayed, and remote-only voices never send text to a remote synthesizer", async () => {
  const f = await setup();
  try {
    for (const unavailable of [[], [remote], [{ ...local, lang: "ja-JP" }]]) {
      voices = unavailable;
      bundle.mod.act(() => speech.dispatchEvent(new window.Event("voiceschanged")));
      assert.equal(f.button().disabled, true); f.click(); assert.equal(playing, null);
      assert.match(f.container.textContent, /You can still type/);
    }
    voices = [local];
    bundle.mod.act(() => speech.dispatchEvent(new window.Event("voiceschanged")));
    assert.equal(f.button().disabled, false); assert.equal(playing, null);
    f.click(); assert.equal(playing!.voice, local);
  } finally { f.cleanup(); }
});
