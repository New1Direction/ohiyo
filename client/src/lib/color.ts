// Pure color helpers for the appearance customizer. No DOM, no deps — so the
// math behind deriving an accent-hover shade and validating picker input is
// unit-testable in isolation.

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** True for a strict 6-digit `#rrggbb` hex (the form `<input type="color">` emits). */
export function isValidHex(hex: string): boolean {
  return HEX6.test(hex);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Darken a hex color toward black by `amount` (0..1, clamped). Invalid input is
 *  returned unchanged so callers never crash on a malformed value. */
export function darken(hex: string, amount: number): string {
  if (!isValidHex(hex)) return hex;
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - clamp(amount, 0, 1);
  return rgbToHex(r * f, g * f, b * f);
}

/** Lighten a hex color toward white by `amount` (0..1, clamped). */
export function lighten(hex: string, amount: number): string {
  if (!isValidHex(hex)) return hex;
  const [r, g, b] = hexToRgb(hex);
  const t = clamp(amount, 0, 1);
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}
