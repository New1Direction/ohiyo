// Personal accent color — a customization layer that sits ON TOP of the active
// theme. Discord locks accent/theme customization behind a paid tier; here it's
// free and one click. The accent is a pure CSS-variable swap (--accent +
// a derived --accent-hover), so it recolors the whole app — buttons, links,
// highlights, focus rings — without touching layout or the virtualized list.

import { applyTheme, loadTheme } from "../themes";
import { darken, isValidHex } from "./color";
import {
  type Density,
  DEFAULT_DENSITY,
  DEFAULT_FONT_SCALE,
  clampFontScale,
  densityVars,
  isDensity,
} from "./density";

const ACCENT_KEY = "kikkacord:accent";
const DENSITY_KEY = "kikkacord:density";
const FONT_SCALE_KEY = "kikkacord:fontScale";

// Fired whenever density/font-scale changes so the virtualized message list can drop
// its cached row heights and re-measure (the only component that can't just repaint
// from a CSS-var swap).
export const APPEARANCE_CHANGED_EVENT = "kc:appearance-changed";
function notifyAppearanceChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
}

/** Curated accent presets — one tap to recolor everything. The first matches the
 *  default Chrome Blue theme so "no override" and "Steel" line up visually. */
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Steel", hex: "#62b0dc" },
  { name: "Sage", hex: "#76a783" },
  { name: "Silver", hex: "#c8d0d5" },
  { name: "Persimmon", hex: "#f2683c" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Grape", hex: "#8a7bff" },
  { name: "Sky", hex: "#3da5f2" },
  { name: "Teal", hex: "#1f9e9e" },
  { name: "Emerald", hex: "#1f9e6b" },
  { name: "Rose", hex: "#eb6f92" },
  { name: "Gold", hex: "#e0992f" },
  { name: "Crimson", hex: "#e0483f" },
];

/** The persisted personal accent override, or null if the user follows the theme. */
export function loadAccent(): string | null {
  const v = localStorage.getItem(ACCENT_KEY);
  return v && isValidHex(v) ? v : null;
}

/** Apply a personal accent over the active theme. Pass null to clear it and fall
 *  back to the active theme's own accent. Persists the choice. */
export function setAccent(hex: string | null): void {
  const root = document.documentElement;
  if (hex === null || !isValidHex(hex)) {
    localStorage.removeItem(ACCENT_KEY);
    const theme = loadTheme();
    root.style.setProperty("--accent", theme.vars["--accent"]);
    root.style.setProperty("--accent-hover", theme.vars["--accent-hover"]);
    return;
  }
  localStorage.setItem(ACCENT_KEY, hex);
  root.style.setProperty("--accent", hex);
  // A slightly darker shade for hover/active — derived so any custom color works.
  root.style.setProperty("--accent-hover", darken(hex, 0.12));
}

/** The currently effective accent hex: the override if set, else the theme's. */
export function getActiveAccent(): string {
  return loadAccent() ?? loadTheme().vars["--accent"];
}

// ── Message density ──────────────────────────────────────────────────────────────
/** The persisted message density, defaulting to cozy. */
export function loadDensity(): Density {
  const v = localStorage.getItem(DENSITY_KEY);
  return isDensity(v) ? v : DEFAULT_DENSITY;
}

/** Apply a message density: swaps the line-height / group-gap / row-estimate CSS vars
 *  and notifies the list to re-measure. Persists the choice. */
export function applyDensity(d: Density): void {
  const density = isDensity(d) ? d : DEFAULT_DENSITY;
  localStorage.setItem(DENSITY_KEY, density);
  const root = document.documentElement;
  const v = densityVars(density);
  root.style.setProperty("--msg-line-height", String(v.lineHeight));
  root.style.setProperty("--msg-group-gap", v.groupGap);
  root.style.setProperty("--msg-line-px", String(v.linePx));
  root.style.setProperty("--msg-base-px", String(v.basePx));
  notifyAppearanceChanged();
}

// ── Font scale ───────────────────────────────────────────────────────────────────
/** The persisted message font scale (relative to the base), snapped to an allowed step. */
export function loadFontScale(): number {
  return clampFontScale(Number.parseFloat(localStorage.getItem(FONT_SCALE_KEY) ?? String(DEFAULT_FONT_SCALE)));
}

/** Apply a message font scale (multiplier on the message base font size). Persists. */
export function applyFontScale(n: number): void {
  const scale = clampFontScale(n);
  localStorage.setItem(FONT_SCALE_KEY, String(scale));
  document.documentElement.style.setProperty("--msg-font-scale", String(scale));
  notifyAppearanceChanged();
}

/** Boot: apply the active theme, then re-apply any personal accent, density, and font
 *  scale on top so they survive reloads and theme changes. Call this instead of applyTheme. */
export function applyActiveAppearance(): void {
  applyTheme(loadTheme());
  const accent = loadAccent();
  if (accent) setAccent(accent);
  applyDensity(loadDensity());
  applyFontScale(loadFontScale());
}
