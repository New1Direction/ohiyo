// Unit tests for the pure color utilities behind the accent customizer.
//   npm run test:unit   (from client/)
//   node --experimental-strip-types --test test/color.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidHex, darken, lighten } from "../src/lib/color.ts";

test("isValidHex accepts 6-digit #rrggbb only", () => {
  assert.equal(isValidHex("#f2683c"), true);
  assert.equal(isValidHex("#FFFFFF"), true);
  assert.equal(isValidHex("#fff"), false); // 3-digit shorthand not supported
  assert.equal(isValidHex("f2683c"), false); // missing hash
  assert.equal(isValidHex("#gggggg"), false); // non-hex chars
  assert.equal(isValidHex("#f2683c "), false); // trailing space
  assert.equal(isValidHex(""), false);
});

test("darken scales channels toward black", () => {
  assert.equal(darken("#ffffff", 0), "#ffffff");
  assert.equal(darken("#ffffff", 1), "#000000");
  assert.equal(darken("#ffffff", 0.1), "#e6e6e6"); // 255*0.9 = 229.5 -> 230 -> e6
  assert.equal(darken("#000000", 0.5), "#000000");
});

test("darken is a no-op on the value but produces a distinct hover shade for a real accent", () => {
  const accent = "#f2683c";
  const hover = darken(accent, 0.12);
  assert.equal(isValidHex(hover), true);
  assert.notEqual(hover, accent);
  // Each channel must be <= the original (darker, never lighter).
  for (let i = 1; i < 7; i += 2) {
    const a = parseInt(accent.slice(i, i + 2), 16);
    const h = parseInt(hover.slice(i, i + 2), 16);
    assert.ok(h <= a, `channel ${i} not darker: ${h} > ${a}`);
  }
});

test("lighten scales channels toward white", () => {
  assert.equal(lighten("#000000", 0), "#000000");
  assert.equal(lighten("#000000", 1), "#ffffff");
  assert.equal(lighten("#000000", 0.5), "#808080"); // 255*0.5 = 127.5 -> 128 -> 80
});

test("darken/lighten clamp the amount and pass invalid hex through unchanged", () => {
  assert.equal(darken("#808080", 2), "#000000"); // amount clamped to 1
  assert.equal(lighten("#808080", 2), "#ffffff");
  assert.equal(darken("not-a-color", 0.2), "not-a-color");
  assert.equal(lighten("#fff", 0.2), "#fff"); // invalid (3-digit) -> unchanged
});
