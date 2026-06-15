// Pure helpers for the message-density + font-scale appearance controls. No DOM or
// storage here so it's unit-testable in isolation (the apply/persist side lives in
// appearance.ts). Density drives the message line-height, the gap between message
// groups, and the per-line pixel estimates the virtualized list uses to size rows.

export type Density = "compact" | "cozy" | "comfortable";

export const DENSITIES: Density[] = ["compact", "cozy", "comfortable"];
export const DEFAULT_DENSITY: Density = "cozy";

// Discrete font scales (relative to the 0.875rem message base). Kept as a fixed set
// so the control is a few clear steps, not a fiddly slider.
export const FONT_SCALES = [0.875, 1, 1.125, 1.25];
export const DEFAULT_FONT_SCALE = 1;

export function isDensity(s: unknown): s is Density {
  return s === "compact" || s === "cozy" || s === "comfortable";
}

/** CSS values for a density level: the message line-height, the inter-group gap, and
 *  the unitless pixel estimates (base row + per text line) the react-window list reads
 *  back when measuring row heights. */
export function densityVars(d: Density): {
  lineHeight: number;
  groupGap: string;
  linePx: number;
  basePx: number;
} {
  switch (d) {
    case "compact":
      return { lineHeight: 1.25, groupGap: "0.0625rem", linePx: 17, basePx: 38 };
    case "comfortable":
      return { lineHeight: 1.7, groupGap: "0.375rem", linePx: 24, basePx: 50 };
    case "cozy":
    default:
      return { lineHeight: 1.45, groupGap: "0.125rem", linePx: 20, basePx: 44 };
  }
}

/** Snap an arbitrary number to the nearest allowed font scale; invalid → default. */
export function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FONT_SCALE;
  let best = FONT_SCALES[0];
  for (const s of FONT_SCALES) {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  }
  return best;
}
