// Voice controls like Discord's: deafen, push to talk, input sensitivity and the call
// shortcuts. Everything here is a pure rule; useVoiceControls and the call engines apply them.

export type InputMode = "voice" | "ptt";

export type VoicePrefs = {
  /** Voice activity sends whenever you speak; push to talk only while a key is held. */
  inputMode: InputMode;
  /** The push to talk key as a KeyboardEvent.code ("KeyV"), or null until one is set. */
  pttKey: string | null;
  /** On: the mic is never held back by level. Off: quieter than `sensitivityDb` is held back. */
  autoSensitivity: boolean;
  /** The level, in dB from -100 (everything) to 0 (only the loudest), that opens the mic. */
  sensitivityDb: number;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = { inputMode: "voice", pttKey: null, autoSensitivity: true, sensitivityDb: -50 };
/** Voice settings belong to this device, as Discord's do. */
export const VOICE_PREFS_KEY = "ohiyo.voicePrefs.v1";
/** Fired on window when the settings change, so a call in progress follows at once. */
export const VOICE_PREFS_EVENT = "ohiyo:voice-prefs";
/** After the push to talk key is let go the mic stays open this long, so the last word isn't clipped. */
export const PTT_TAIL_MS = 200;
/** Once below the closing level, the sensitivity gate stays open this long. */
export const VAD_HOLD_MS = 300;
/** Once open, the gate closes only this far below the opening level, so it doesn't chatter. */
export const VAD_HYSTERESIS_DB = 6;
export const MIN_SENSITIVITY_DB = -100;
const MAX_KEY_CODE_LENGTH = 32;

type ReadStore = { getItem(key: string): string | null };
type WriteStore = { setItem(key: string, value: string): void };

function defaultStore(): (ReadStore & WriteStore) | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Anything read back from storage, made into valid settings. */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_VOICE_PREFS;
  const r = raw as Record<string, unknown>;
  const inputMode: InputMode = r.inputMode === "ptt" ? "ptt" : "voice";
  const pttKey =
    typeof r.pttKey === "string" && r.pttKey.length > 0 && r.pttKey.length <= MAX_KEY_CODE_LENGTH ? r.pttKey : null;
  const autoSensitivity = typeof r.autoSensitivity === "boolean" ? r.autoSensitivity : true;
  const db = typeof r.sensitivityDb === "number" && Number.isFinite(r.sensitivityDb) ? r.sensitivityDb : DEFAULT_VOICE_PREFS.sensitivityDb;
  return { inputMode, pttKey, autoSensitivity, sensitivityDb: Math.max(MIN_SENSITIVITY_DB, Math.min(0, db)) };
}

export function loadVoicePrefs(store: ReadStore | null | undefined = defaultStore()): VoicePrefs {
  try {
    const text = store?.getItem(VOICE_PREFS_KEY);
    return text ? normalizeVoicePrefs(JSON.parse(text)) : DEFAULT_VOICE_PREFS;
  } catch {
    return DEFAULT_VOICE_PREFS;
  }
}

/** Saves the settings; false when storage is unavailable (private window, blocked site data). */
export function saveVoicePrefs(prefs: VoicePrefs, store: WriteStore | null | undefined = defaultStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(VOICE_PREFS_KEY, JSON.stringify(normalizeVoicePrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

// ── Deafen ────────────────────────────────────────────────────────────────────

export type MicState = { muted: boolean; deafened: boolean; mutedBeforeDeafen: boolean };

/** Deafening mutes the mic as well; undeafening puts the mic back as it was before. */
export function toggleDeafenState(s: MicState): MicState {
  if (s.deafened) return { muted: s.mutedBeforeDeafen, deafened: false, mutedBeforeDeafen: false };
  return { muted: true, deafened: true, mutedBeforeDeafen: s.muted };
}

/** Unmuting while deafened undeafens too (as Discord does); otherwise it just flips mute. */
export function toggleMuteState(s: MicState): MicState {
  if (s.deafened) return { muted: false, deafened: false, mutedBeforeDeafen: false };
  return { muted: !s.muted, deafened: false, mutedBeforeDeafen: false };
}

// ── Push to talk ──────────────────────────────────────────────────────────────

export type PttState = { held: boolean; releasedAt: number | null };
export const PTT_IDLE: PttState = { held: false, releasedAt: null };

export function pttPress(_s: PttState): PttState {
  return { held: true, releasedAt: null };
}

export function pttRelease(s: PttState, now: number): PttState {
  return s.held ? { held: false, releasedAt: now } : s;
}

/** Whether push to talk lets the mic through at `now`: while held, and for a short tail after. */
export function pttOpen(s: PttState, now: number, tailMs: number = PTT_TAIL_MS): boolean {
  if (s.held) return true;
  return s.releasedAt !== null && now - s.releasedAt < tailMs;
}

// ── Input sensitivity ─────────────────────────────────────────────────────────

export type VadState = { open: boolean; lastAboveAt: number | null };
export const VAD_CLOSED: VadState = { open: false, lastAboveAt: null };

/**
 * One reading of the mic level through the sensitivity gate. It opens at the threshold; once
 * open it only counts as quiet below the threshold minus the hysteresis, and then stays open
 * for the hold time, so speech with small dips doesn't chop.
 */
export function vadStep(s: VadState, levelDb: number, now: number, thresholdDb: number): VadState {
  if (!s.open) return levelDb >= thresholdDb ? { open: true, lastAboveAt: now } : s;
  if (levelDb >= thresholdDb - VAD_HYSTERESIS_DB) return { open: true, lastAboveAt: now };
  const since = s.lastAboveAt ?? now;
  return now - since > VAD_HOLD_MS ? VAD_CLOSED : s;
}

/** Root mean square of time-domain samples between -1 and 1. */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** A level in dB; silence floors at the quietest setting rather than -Infinity. */
export function levelToDb(rms: number): number {
  if (!(rms > 0)) return MIN_SENSITIVITY_DB;
  return Math.max(MIN_SENSITIVITY_DB, 20 * Math.log10(rms));
}

/**
 * Whether the mic is let through, before mute and deafen (the call engine applies those).
 * Push to talk ignores sensitivity; automatic sensitivity never holds the mic back.
 */
export function transmitGateOpen(g: { inputMode: InputMode; pttOpen: boolean; autoSensitivity: boolean; vadOpen: boolean }): boolean {
  if (g.inputMode === "ptt") return g.pttOpen;
  return g.autoSensitivity || g.vadOpen;
}

// ── Shortcuts and keys ────────────────────────────────────────────────────────

export type CallShortcut = "toggle-mute" | "toggle-deafen";
type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/**
 * Ctrl+Shift+M mutes and Ctrl+Shift+D deafens (⌘ instead of Ctrl on a Mac). Thanks to the
 * modifiers they work even while typing, as in Discord.
 */
export function callShortcutFor(e: KeyLike, isMac: boolean): CallShortcut | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || !e.shiftKey || e.altKey) return null;
  const letter = e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (letter === "m") return "toggle-mute";
  if (letter === "d") return "toggle-deafen";
  return null;
}

type TargetLike = { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined;
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** Whether a key press here would type text. */
export function isTypingTarget(t: TargetLike): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((t.type ?? "text").toLowerCase());
  return false;
}

/** Whether this key press is push to talk: the chosen key, unless it's being typed as text. */
export function pttKeyApplies(e: { code: string; key: string }, pttKey: string | null, target: TargetLike): boolean {
  if (!pttKey || e.code !== pttKey) return false;
  return !(isTypingTarget(target) && e.key.length === 1);
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  CapsLock: "Caps Lock",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const SIDE_KEYS: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "⌘" };

/** A KeyboardEvent.code as people know it: "KeyV" → "V", "ControlLeft" → "Left Ctrl". */
export function describeKey(code: string | null): string {
  if (!code) return "";
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^Mouse\d+$/.test(code)) return `Mouse ${code.slice(5)}`;
  const side = /^(Control|Alt|Shift|Meta)(Left|Right)$/.exec(code);
  if (side) return `${side[2]} ${SIDE_KEYS[side[1]]}`;
  return code;
}
