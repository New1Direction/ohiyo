import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
type Song = { title: string; artist?: string | null; url?: string | null };
type Mod = { act: (callback: () => void) => void; mountSongs: (el: unknown, songs?: Song[]) => () => void; renderCard: (songs: Song[], preview?: boolean) => string; songError: (song: Song) => string | null };
let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "profileEditor.tsx"));
});
after(async () => {
  await bundle?.cleanup(); await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  }
});
function setup(songs: Song[] = []) {
  const container = document.createElement("div"); document.body.append(container);
  const unmount = bundle.mod.mountSongs(container, songs);
  return { container, click: (selector: string) => bundle.mod.act(() => container.querySelector<HTMLButtonElement>(selector)!.click()), cleanup: () => { unmount(); container.remove(); } };
}
test("empty profile starts with one add action, not nine empty text boxes", () => {
  const f = setup();
  try {
    assert.equal(f.container.querySelectorAll("input").length, 0);
    f.click(".kc-song-add");
    assert.equal(f.container.querySelectorAll(".kc-song-entry").length, 1);
    assert.equal(f.container.querySelector(".kc-song-toggle")!.getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement, f.container.querySelector("input"));
    assert.equal(f.container.querySelector("input")!.maxLength, 80);
    assert.equal(f.container.querySelector('input[type="url"]')!.maxLength, 240);
    f.click(".kc-song-add"); f.click(".kc-song-add");
    assert.equal(f.container.querySelectorAll(".kc-song-entry").length, 3);
    assert.equal(f.container.querySelector(".kc-song-add"), null);
    f.click(".kc-song-remove");
    assert.equal(f.container.querySelectorAll(".kc-song-entry").length, 2);
    assert.ok(f.container.querySelector(".kc-song-add"));
  } finally { f.cleanup(); }
});
test("opening and closing songs preserves unsaved data; remove preserves remaining order", () => {
  const songs = [{ title: "One", artist: "Artist", url: "https://example.com/music" }, { title: "Two" }];
  const f = setup(songs);
  try {
    for (let i = 0; i < 4; i++) f.click(".kc-song-toggle");
    assert.deepEqual(JSON.parse(f.container.querySelector("output")!.textContent), songs);
    assert.equal(f.container.querySelector(".kc-song-fields")!.hasAttribute("hidden"), true);
    f.click(".kc-song-remove");
    assert.deepEqual(JSON.parse(f.container.querySelector("output")!.textContent), [songs[1]]);
  } finally { f.cleanup(); }
});
test("songs validate optional links without provider API or unsafe schemes", () => {
  for (const url of [undefined, "", "https://open.spotify.com/track/test", "http://example.com/song"]) assert.equal(bundle.mod.songError({ title: "Song", url }), null);
  for (const url of ["javascript:alert(1)", "spotify:track:id", "not-a-url"]) assert.ok(bundle.mod.songError({ title: "Song", url }));
  assert.ok(bundle.mod.songError({ title: "   ", artist: "Artist" }));
});
test("profile card puts details above the banner and only exposes safe music links", () => {
  const songs = [{ title: "Safe", url: "https://example.com/song" }, { title: "Unsafe", url: "javascript:alert(1)" }];
  document.body.innerHTML = bundle.mod.renderCard(songs);
  const details = document.querySelector<HTMLElement>(".kc-profile-details")!;
  assert.equal(details.style.position, "relative"); assert.equal(details.style.zIndex, "1");
  assert.equal(details.style.overflowWrap, "anywhere");
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.match(document.querySelector("a")!.getAttribute("aria-label")!, /opens in a new tab/);
  document.body.innerHTML = bundle.mod.renderCard(songs, true);
  assert.equal(document.querySelectorAll("a").length, 0);
});
test("editing a title, artist and link updates only that song's draft", () => {
  const f = setup([{ title: "Before", artist: "Original" }, { title: "Keep me" }]);
  try {
    f.click(".kc-song-toggle");
    const inputs = f.container.querySelectorAll<HTMLInputElement>(".kc-song-fields:not([hidden]) input");
    for (const [i, value] of ["After", "New artist", "https://youtube.com/watch?v=abc"].entries()) {
      bundle.mod.act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(inputs[i], value);
        inputs[i].dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    }
    assert.deepEqual(JSON.parse(f.container.querySelector("output")!.textContent), [{ title: "After", artist: "New artist", url: "https://youtube.com/watch?v=abc" }, { title: "Keep me" }]);
    f.click(".kc-song-toggle"); f.click(".kc-song-toggle");
    assert.equal(f.container.querySelector<HTMLInputElement>("input")!.value, "After");
  } finally { f.cleanup(); }
});
