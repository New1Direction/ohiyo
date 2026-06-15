// Personal accent color — a customization layer that sits ON TOP of the active
// theme. Discord locks accent/theme customization behind a paid tier; here it's
// free and one click. The accent is a pure CSS-variable swap (--accent +
// a derived --accent-hover), so it recolors the whole app — buttons, links,
// highlights, focus rings — without touching layout or the virtualized list.

import { applyTheme, loadTheme } from "../themes";
import { darken, isValidHex } from "./color";

const ACCENT_KEY = "kikkacord:accent";

/** Curated accent presets — one tap to recolor everything. The first matches the
 *  default Daybreak theme so "no override" and "Persimmon" line up visually. */
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Persimmon", hex: "#f2683c" },
  { name: "Blurple", hex: "#5865f2" },
  { name: "Grape", hex: "#7c6dfa" },
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

/** Boot: apply the active theme, then re-apply any personal accent on top so the
 *  override survives reloads and theme changes. Call this instead of applyTheme. */
export function applyActiveAppearance(): void {
  applyTheme(loadTheme());
  const accent = loadAccent();
  if (accent) setAccent(accent);
}
