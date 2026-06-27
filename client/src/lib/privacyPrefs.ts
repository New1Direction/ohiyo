// Privacy preferences live inside the shared user-prefs blob so they follow a
// person across browsers/devices. Keep this helper pure-ish and merge-safe so it
// can be used by App boot and Settings without clobbering Appearance/plugin prefs.

export type PrivacyPrefs = {
  /** Metadata privacy mode: hide live behavioural signals from other people. */
  metadataMode: boolean;
};

export const PRIVACY_PREFS_KEY = "privacy";
export const PRIVACY_CHANGED_EVENT = "kc:privacy-changed";
const LOCAL_PRIVACY_KEY = "kc:privacy-mode:v1";

export const DEFAULT_PRIVACY_PREFS: PrivacyPrefs = {
  metadataMode: false,
};

export function readPrivacyPrefs(prefs: Record<string, unknown> | null | undefined): PrivacyPrefs {
  const raw = prefs?.[PRIVACY_PREFS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PRIVACY_PREFS };
  const obj = raw as Record<string, unknown>;
  return {
    metadataMode: obj.metadataMode === true,
  };
}

export function mergePrivacyIntoPrefs(
  prefs: Record<string, unknown> | null | undefined,
  privacy: PrivacyPrefs
): Record<string, unknown> {
  return {
    ...(prefs ?? {}),
    [PRIVACY_PREFS_KEY]: {
      metadataMode: privacy.metadataMode === true,
    },
  };
}

export function loadLocalPrivacyPrefs(): PrivacyPrefs {
  try {
    const raw = localStorage.getItem(LOCAL_PRIVACY_KEY);
    if (!raw) return { ...DEFAULT_PRIVACY_PREFS };
    const parsed = JSON.parse(raw) as Partial<PrivacyPrefs>;
    return { metadataMode: parsed.metadataMode === true };
  } catch {
    return { ...DEFAULT_PRIVACY_PREFS };
  }
}

export function saveLocalPrivacyPrefs(privacy: PrivacyPrefs): void {
  try {
    localStorage.setItem(LOCAL_PRIVACY_KEY, JSON.stringify({ metadataMode: privacy.metadataMode === true }));
  } catch {
    /* storage may be disabled */
  }
  window.dispatchEvent(new CustomEvent<PrivacyPrefs>(PRIVACY_CHANGED_EVENT, { detail: privacy }));
}
