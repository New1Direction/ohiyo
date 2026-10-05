// The bar that offers a new version. It asks; it never installs by itself.
//   node --experimental-strip-types --test test/updateBar.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Props = { version: string; isInstalling: boolean; onInstall: () => void; onLater: () => void };
type Mod = { renderUpdateBar: (props: Props) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderUpdateBar.tsx"));
});
after(async () => {
  await bundle?.cleanup();
});

const idle: Props = { version: "0.3.1", isInstalling: false, onInstall() {}, onLater() {} };

test("it names the version and offers both choices", () => {
  const html = bundle.mod.renderUpdateBar(idle);
  assert.match(html, /role="status"/);
  assert.match(html, /Ohiyo 0\.3\.1 is ready/);
  assert.match(html, /<button[^>]*>Update now<\/button>/);
  assert.match(html, /<button[^>]*>Later<\/button>/);
});

test("while installing, the choices are replaced by what is happening", () => {
  const html = bundle.mod.renderUpdateBar({ ...idle, isInstalling: true });
  assert.match(html, /Updating… Ohiyo will restart\./);
  assert.doesNotMatch(html, /Update now|Later/);
});
