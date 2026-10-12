// What Enter does in a message box. With a mouse and a keyboard, Enter sends and Shift+Enter
// starts a new line. On a touch screen the Send button is always showing, so Enter starts a
// new line there, like Discord's phone app. Enter that confirms a word in an input method
// (Japanese, Chinese, Korean…) belongs to the input method either way.
//   node --experimental-strip-types --test test/composerKeys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enterAction, FINE_POINTER_QUERY } from "../src/lib/composerKeys.ts";

const plain = { shiftKey: false, isComposing: false };

test("with a mouse and a keyboard, Enter sends and Shift+Enter starts a new line", () => {
  assert.equal(enterAction(plain, true), "send");
  assert.equal(enterAction({ ...plain, shiftKey: true }, true), "newline");
});

test("on a touch screen, Enter starts a new line; the Send button sends", () => {
  assert.equal(enterAction(plain, false), "newline");
  assert.equal(enterAction({ ...plain, shiftKey: true }, false), "newline");
});

test("Enter that confirms a word in an input method is the input method's", () => {
  assert.equal(enterAction({ ...plain, isComposing: true }, true), "ime");
  assert.equal(enterAction({ ...plain, isComposing: true }, false), "ime");
});

test("Enter sends exactly where Send hides until there's something to send", () => {
  // The same media query decides both, so there's never a box with no way to send.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.css"), "utf8");
  const rule = new RegExp(
    `@media ${FINE_POINTER_QUERY.replace(/[()]/g, "\\$&")} \\{\\s*\\.kc-composer-send:not\\(\\.active\\) \\{ display: none; \\}`,
  );
  assert.match(css, rule);
});
