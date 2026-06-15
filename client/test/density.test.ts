// Tests for the pure density / font-scale helpers.
//   node --experimental-strip-types --test test/density.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDensity,
  densityVars,
  clampFontScale,
  DENSITIES,
  FONT_SCALES,
  DEFAULT_FONT_SCALE,
} from "../src/lib/density.ts";

test("isDensity accepts the three levels and rejects anything else", () => {
  for (const d of DENSITIES) assert.equal(isDensity(d), true);
  for (const bad of ["", "tiny", null, undefined, 1, {}]) assert.equal(isDensity(bad), false);
});

test("densityVars line-height increases compact → cozy → comfortable", () => {
  const c = densityVars("compact");
  const z = densityVars("cozy");
  const f = densityVars("comfortable");
  assert.ok(c.lineHeight < z.lineHeight && z.lineHeight < f.lineHeight, "line-height must grow with looseness");
  assert.ok(c.basePx < z.basePx && z.basePx < f.basePx, "row base px must grow with looseness");
  assert.ok(c.linePx <= z.linePx && z.linePx <= f.linePx);
  // group gap is a CSS length string
  for (const v of [c, z, f]) assert.match(v.groupGap, /rem$/);
});

test("unknown density falls back to cozy's values", () => {
  // @ts-expect-error — exercising the default branch with an invalid value
  assert.deepEqual(densityVars("nope"), densityVars("cozy"));
});

test("clampFontScale snaps to the nearest allowed step", () => {
  assert.equal(clampFontScale(1), 1);
  assert.equal(clampFontScale(0.9), 0.875, "0.9 is closest to 0.875");
  assert.equal(clampFontScale(1.1), 1.125, "1.1 is closest to 1.125");
  assert.equal(clampFontScale(1.25), 1.25);
  assert.equal(clampFontScale(99), FONT_SCALES[FONT_SCALES.length - 1], "clamps above range");
});

test("clampFontScale returns the default for non-finite input", () => {
  assert.equal(clampFontScale(NaN), DEFAULT_FONT_SCALE);
  assert.equal(clampFontScale(Infinity), DEFAULT_FONT_SCALE);
});
