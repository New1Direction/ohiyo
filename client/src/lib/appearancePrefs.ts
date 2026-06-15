// Pure, merge-safe helpers for the appearance slice of the shared user-prefs blob.
// No runtime imports (Theme is type-only) so this is unit-testable in isolation —
// the merge must NEVER clobber other keys (plugins, notifications, …) since the
// server's POST /prefs replaces the whole blob.

import type { Theme } from "../themes";

const APPEARANCE_KEY = "appearance";

export type AppearancePrefs = { theme?: Theme; accent?: string | null };

/** Return a new prefs object with the appearance slice set, leaving all other keys intact. */
export function mergeAppearanceIntoPrefs(
  prefs: Record<string, unknown>,
  appearance: AppearancePrefs,
): Record<string, unknown> {
  return { ...prefs, [APPEARANCE_KEY]: appearance };
}

/** Extract the appearance slice from a prefs blob, or null if absent/malformed. */
export function readAppearancePrefs(
  prefs: Record<string, unknown> | null | undefined,
): AppearancePrefs | null {
  if (!prefs || typeof prefs !== "object") return null;
  const a = prefs[APPEARANCE_KEY];
  return a && typeof a === "object" ? (a as AppearancePrefs) : null;
}
