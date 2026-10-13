// Stub: the tests in test/notificationSounds.test.ts describe what this module must do.
export type SoundId = "chime";
export type SoundMode = "dms-mentions" | "all";
export type SoundPrefs = { enabled: boolean; sound: SoundId; volume: number; mode: SoundMode };
export type SoundDecision = {
  fromMe: boolean;
  blocked: boolean;
  notifyAllowed: boolean;
  lookingAtIt: boolean;
  isDirect: boolean;
  mentioned: boolean;
};

export const SOUNDS: readonly { id: SoundId; label: string }[] = [];
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: false, sound: "chime", volume: 0, mode: "all" };

type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };

export function loadSoundPrefs(_storage?: Reader): SoundPrefs {
  return DEFAULT_SOUND_PREFS;
}

export function saveSoundPrefs(_prefs: SoundPrefs, _storage?: Writer): void {}

export function shouldPlaySound(_d: SoundDecision, _prefs: SoundPrefs): boolean {
  return true;
}

export function playSound(_id: SoundId, _volume: number): void {}
