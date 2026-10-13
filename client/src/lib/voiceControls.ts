// Voice controls: deafen, push to talk, input sensitivity and the call shortcuts. Placeholder
// so the tests load; the behaviour comes in the next commit.

export type InputMode = "voice" | "ptt";

export type VoicePrefs = {
  inputMode: InputMode;
  pttKey: string | null;
  autoSensitivity: boolean;
  sensitivityDb: number;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = { inputMode: "voice", pttKey: null, autoSensitivity: true, sensitivityDb: -50 };
export const VOICE_PREFS_KEY = "ohiyo.voicePrefs.v1";
export const VOICE_PREFS_EVENT = "ohiyo:voice-prefs";
export const PTT_TAIL_MS = 200;
export const VAD_HOLD_MS = 300;
export const VAD_HYSTERESIS_DB = 6;
export const MIN_SENSITIVITY_DB = -100;

type ReadStore = { getItem(key: string): string | null };
type WriteStore = { setItem(key: string, value: string): void };

export function normalizeVoicePrefs(_raw: unknown): VoicePrefs {
  return DEFAULT_VOICE_PREFS;
}

export function loadVoicePrefs(_store?: ReadStore | null): VoicePrefs {
  return DEFAULT_VOICE_PREFS;
}

export function saveVoicePrefs(_prefs: VoicePrefs, _store?: WriteStore | null): boolean {
  return false;
}

export type MicState = { muted: boolean; deafened: boolean; mutedBeforeDeafen: boolean };

export function toggleDeafenState(s: MicState): MicState {
  return s;
}

export function toggleMuteState(s: MicState): MicState {
  return s;
}

export type PttState = { held: boolean; releasedAt: number | null };
export const PTT_IDLE: PttState = { held: false, releasedAt: null };

export function pttPress(s: PttState): PttState {
  return s;
}

export function pttRelease(s: PttState, _now: number): PttState {
  return s;
}

export function pttOpen(_s: PttState, _now: number, _tailMs: number = PTT_TAIL_MS): boolean {
  return true;
}

export type VadState = { open: boolean; lastAboveAt: number | null };
export const VAD_CLOSED: VadState = { open: false, lastAboveAt: null };

export function vadStep(s: VadState, _levelDb: number, _now: number, _thresholdDb: number): VadState {
  return s;
}

export function rmsOf(_samples: ArrayLike<number>): number {
  return 0;
}

export function levelToDb(_rms: number): number {
  return 0;
}

export function transmitGateOpen(_g: {
  inputMode: InputMode;
  pttOpen: boolean;
  autoSensitivity: boolean;
  vadOpen: boolean;
}): boolean {
  return true;
}

export type CallShortcut = "toggle-mute" | "toggle-deafen";
type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

export function callShortcutFor(_e: KeyLike, _isMac: boolean): CallShortcut | null {
  return null;
}

type TargetLike = { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined;

export function isTypingTarget(_t: TargetLike): boolean {
  return false;
}

export function pttKeyApplies(_e: { code: string; key: string }, _pttKey: string | null, _target: TargetLike): boolean {
  return false;
}

export function describeKey(code: string | null): string {
  return code ?? "";
}
