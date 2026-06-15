// Cross-device appearance sync. Your theme + accent are stored in the user-prefs
// blob on the server, so they follow you to any device or browser. localStorage
// stays the local-first source for warm first paint; this reconciles with the
// server on login and pushes changes (debounced, merge-safe).

import { api } from "../api";
import { applyTheme, loadTheme } from "../themes";
import { applyDensity, applyFontScale, loadAccent, loadDensity, loadFontScale, setAccent } from "./appearance";
import { mergeAppearanceIntoPrefs, readAppearancePrefs } from "./appearancePrefs";

/** Pull the user's saved appearance from the server and apply it. Local appearance
 *  was already applied at boot, so this only matters when another device changed it. */
export async function pullAppearance(token: string): Promise<void> {
  try {
    const prefs = await api.getPrefs(token);
    const a = readAppearancePrefs(prefs);
    if (!a) return;
    if (a.theme?.vars) applyTheme(a.theme); // also persists locally
    setAccent(a.accent ?? null);
    // Only overwrite when the server actually carries the field, so a blob that
    // predates density/font-scale doesn't reset a local choice to the default.
    if (a.density != null) applyDensity(a.density);
    if (a.fontScale != null) applyFontScale(a.fontScale);
  } catch {
    /* offline / unauthenticated — keep the local appearance */
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the current appearance to the server, debounced and merge-safe (never
 *  clobbers other prefs keys). Safe to call on every appearance change. */
export function pushAppearance(token: string): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void (async () => {
      try {
        const prefs = (await api.getPrefs(token)) ?? {};
        const merged = mergeAppearanceIntoPrefs(prefs, {
          theme: loadTheme(),
          accent: loadAccent(),
          density: loadDensity(),
          fontScale: loadFontScale(),
        });
        await api.setPrefs(token, merged);
      } catch {
        /* ignore — localStorage already holds the change; we retry on the next edit */
      }
    })();
  }, 600);
}
