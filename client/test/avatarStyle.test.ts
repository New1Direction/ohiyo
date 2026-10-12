// Default avatars (people with no picture) were invisible in light themes: the inline style
// put the gradient in the `background` shorthand and then passed `backgroundImage: undefined`,
// which React writes as an empty background-image, erasing the gradient. The circle was
// transparent, so its white mark vanished on a white page.
//   node --experimental-strip-types --test test/avatarStyle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarStyle, defaultAvatarStops } from "../src/lib/avatarStyle.ts";

// OKLCH → linear sRGB (clamped to the gamut) → WCAG relative luminance.
function luminance(css: string): number {
  const m = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(css);
  assert.ok(m, `an oklch colour: ${css}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const r = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
const whiteContrast = (css: string) => 1.05 / (luminance(css) + 0.05);

test("a default avatar's style never mixes the background shorthand with its longhands", () => {
  for (const url of [null, "https://files.example/a.png"]) {
    const style = avatarStyle("u1", url);
    assert.equal("background" in style, false, "no `background` shorthand: React would erase it with the longhand");
  }
});

test("with no picture the gradient is the background image, over a solid colour", () => {
  const style = avatarStyle("u1", null);
  assert.match(String(style.backgroundImage), /^linear-gradient\(/);
  assert.ok(style.backgroundColor, "a solid colour under the gradient, in case the gradient can't be drawn");
});

test("with a picture the picture is the background image", () => {
  assert.equal(avatarStyle("u1", "https://files.example/a.png").backgroundImage, "url(https://files.example/a.png)");
});

test("the white mark reads at 3:1 or more on every default avatar colour", () => {
  let worst = Infinity;
  for (let i = 0; i < 2000; i++) {
    for (const stop of defaultAvatarStops(`user-${i}`)) worst = Math.min(worst, whiteContrast(stop));
  }
  assert.ok(worst >= 3, `worst contrast ${worst.toFixed(2)}:1`);
});

test("a person keeps the same colours", () => {
  assert.deepEqual(defaultAvatarStops("abc"), defaultAvatarStops("abc"));
  assert.notDeepEqual(defaultAvatarStops("abc"), defaultAvatarStops("abd"));
});
