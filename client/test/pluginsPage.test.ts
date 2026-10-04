// The Plugins settings page, and the built-in plugins it lists. The page used to open with a
// developer form ("a JavaScript ES module that exports a default OhiyoPlugin object"), tag
// every row "v1.0.0 · Ohiyo", and list switches that changed nothing; the switch itself had
// no name or state for a screen reader.
//   node --experimental-strip-types --test test/pluginsPage.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Plugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  css?: string;
  onLoad?: unknown;
  transformMessage?: unknown;
  transformSend?: (text: string) => string;
};
type Manager = { installFromUrl: (url: string) => Promise<string> };
type Mod = {
  BUILTIN_PLUGINS: Plugin[];
  PluginManager: new (api: unknown) => Manager;
  renderPluginsTab: (enabledIds: string[], userPlugins?: Plugin[]) => string;
};
let bundle: Bundle<Mod>;
const g = globalThis as Record<string, unknown>;

before(async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.window = globalThis;
  g.document = { documentElement: { style: {} } };
  g.location = { href: "https://app.example/", hostname: "app.example" };
  bundle = await bundleEntry<Mod>(join(fixtures, "renderPluginsTab.tsx"));
});

after(async () => {
  await bundle?.cleanup();
});

const theirs: Plugin = { id: "dice", name: "Dice roller", description: "Rolls dice.", version: "2.1.0", author: "mika" };

// The <button role="switch"> for a plugin, by its accessible name.
function switchFor(html: string, name: string): string {
  const tags = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
  const tag = tags.find((t) => t.includes(`aria-label="${name}"`));
  assert.ok(tag, `no switch named ${name}`);
  return tag;
}

test("every built-in plugin does something when it is switched on", () => {
  for (const p of bundle.mod.BUILTIN_PLUGINS) {
    assert.ok(p.onLoad || p.transformMessage || p.transformSend, `${p.id} has no behaviour, only a switch`);
  }
  const ids = bundle.mod.BUILTIN_PLUGINS.map((p) => p.id);
  // These four changed nothing: two had no way to enter a value, two restyled nothing.
  for (const gone of ["custom-css", "font-picker", "link-preview", "code-highlight"]) {
    assert.ok(!ids.includes(gone), `${gone} is still listed`);
  }
  // Spoilers are part of chat for everyone now, not a switch only the reader can flip.
  assert.ok(!ids.includes("spoiler-text"));
});

test("plugin descriptions are plain sentences, with no developer words", () => {
  for (const p of bundle.mod.BUILTIN_PLUGINS) {
    assert.match(p.description, /^[A-Z].*\.$/s, `${p.id}: "${p.description}"`);
    assert.doesNotMatch(`${p.name} ${p.description}`, /\b(URL|CSS|inject|syntax|UNIX|module|servers?|plugin settings)\b/i, p.id);
  }
});

test("/me sends italics the chat actually renders", () => {
  const commands = bundle.mod.BUILTIN_PLUGINS.find((p) => p.id === "chat-commands");
  assert.equal(commands?.transformSend?.("/me waves"), "*waves*");
});

test("focus mode never hides the sidebars on a phone, where they are the only way back", () => {
  const focus = bundle.mod.BUILTIN_PLUGINS.find((p) => p.id === "zen-mode");
  assert.match(focus?.css ?? "", /@media \(min-width: 769px\)/);
  assert.match(focus?.description ?? "", /Ctrl\+,/);
});

test("every plugin has a switch a screen reader can name and read", () => {
  const html = bundle.mod.renderPluginsTab(["big-emoji"]);
  for (const p of bundle.mod.BUILTIN_PLUGINS) {
    const tag = switchFor(html, p.name);
    assert.match(tag, new RegExp(`aria-checked="${p.id === "big-emoji"}"`), p.name);
    assert.match(tag, /type="button"/);
  }
});

test("the page explains itself and leads with the list, not a developer form", () => {
  const html = bundle.mod.renderPluginsTab([]);
  assert.match(html, /Small extras you can switch on or off/);
  assert.match(html, /Made by Ohiyo/);
  assert.doesNotMatch(html, /ES module|OhiyoPlugin|Install Plugin from URL|Built-in|no data leaves your device/);
  assert.doesNotMatch(html, /v1\.0\.0/);
  assert.ok(html.indexOf("Made by Ohiyo") < html.indexOf("Add a plugin from a link"), "the list comes first");
  // Nothing has been added, so there is no empty "Added by you" section.
  assert.doesNotMatch(html, /Added by you/);
});

test("plugins someone else wrote are listed apart, with who made them and a way to remove them", () => {
  const html = bundle.mod.renderPluginsTab(["dice"], [theirs]);
  assert.match(html, /Added by you/);
  assert.match(html, /by mika/);
  assert.match(html, /aria-label="Remove Dice roller"/);
  assert.match(switchFor(html, "Dice roller"), /aria-checked="true"/);
});

test("adding a plugin from a link says what such a plugin can and cannot do", () => {
  const html = bundle.mod.renderPluginsTab([]);
  assert.match(html, /can read messages as they arrive/);
  assert.match(html, /end-to-end encrypted/);
  assert.match(html, /only add links you trust/);
});

test("in a browser the page says adding from a link needs the desktop app; the desktop app shows the box", () => {
  const web = bundle.mod.renderPluginsTab([]);
  assert.match(web, /only works in the Ohiyo desktop app/);
  assert.doesNotMatch(web, /<input/);
  g.__TAURI_INTERNALS__ = {};
  try {
    const desktop = bundle.mod.renderPluginsTab([]);
    assert.match(desktop, /<input[^>]*aria-label="Link to a plugin"/);
    assert.doesNotMatch(desktop, /only works in the Ohiyo desktop app/);
  } finally {
    delete g.__TAURI_INTERNALS__;
  }
});

test("a link that cannot be downloaded gets a plain message, not a developer one", async () => {
  g.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const manager = new bundle.mod.PluginManager({ toast() {} });
  await assert.rejects(manager.installFromUrl("https://plugins.example/dice.js"), (err: Error) => {
    assert.equal(err.message, "Couldn't download that plugin. Check the link and try again.");
    return true;
  });
});
