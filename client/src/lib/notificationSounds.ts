// Notification sounds. A sound follows the same rules as a notification (mutes, a space's
// level, blocked people, not the chat you're looking at) and, by default, only DMs and
// @mentions make one. The sounds are a few notes made with WebAudio: no audio files.

export type SoundId = "chime" | "pop" | "bell" | "drop" | "tick";
export type SoundMode = "dms-mentions" | "all";
export type SoundPrefs = { enabled: boolean; sound: SoundId; volume: number; mode: SoundMode };

/** What's known about a message when deciding on a sound; the first four come from the
 * notification rules, which already ran. */
export type SoundDecision = {
  fromMe: boolean;
  blocked: boolean;
  /** The notification settings let it through (not muted, the space's level allows it). */
  notifyAllowed: boolean;
  lookingAtIt: boolean;
  /** A DM or group chat. */
  isDirect: boolean;
  mentioned: boolean;
};

export const SOUNDS: readonly { id: SoundId; label: string }[] = [
  { id: "chime", label: "Chime" },
  { id: "pop", label: "Pop" },
  { id: "bell", label: "Bell" },
  { id: "drop", label: "Drop" },
  { id: "tick", label: "Tick" },
];

export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, sound: "chime", volume: 0.6, mode: "dms-mentions" };

const KEY = "ohiyo.soundPrefs.v1";

type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };

function defaultStorage(): (Reader & Writer) | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** This device's sound settings; anything missing or odd falls back to the defaults. */
export function loadSoundPrefs(storage: Reader | null = defaultStorage()): SoundPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return DEFAULT_SOUND_PREFS;
    const p = JSON.parse(raw) as Partial<Record<keyof SoundPrefs, unknown>>;
    const valid =
      typeof p.enabled === "boolean" &&
      SOUNDS.some((s) => s.id === p.sound) &&
      typeof p.volume === "number" &&
      p.volume >= 0 &&
      p.volume <= 1 &&
      (p.mode === "dms-mentions" || p.mode === "all");
    return valid ? (p as SoundPrefs) : DEFAULT_SOUND_PREFS;
  } catch {
    return DEFAULT_SOUND_PREFS;
  }
}

export function saveSoundPrefs(prefs: SoundPrefs, storage: Writer | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked (private window, say): the choice lasts until the page closes.
  }
}

export function shouldPlaySound(d: SoundDecision, prefs: SoundPrefs): boolean {
  if (!prefs.enabled || d.fromMe || d.blocked || !d.notifyAllowed || d.lookingAtIt) return false;
  return prefs.mode === "all" || d.isDirect || d.mentioned;
}

// Each sound is a few short tones: [frequency Hz, start s, length s, waveform].
type Note = [number, number, number, OscillatorType];
const NOTES: Record<SoundId, Note[]> = {
  chime: [
    [880, 0, 0.18, "sine"],
    [1318.5, 0.09, 0.26, "sine"],
  ],
  pop: [[620, 0, 0.07, "triangle"]],
  bell: [
    [1046.5, 0, 0.5, "sine"],
    [2093, 0, 0.25, "sine"],
  ],
  drop: [
    [740, 0, 0.09, "sine"],
    [554.4, 0.08, 0.14, "sine"],
  ],
  tick: [[1760, 0, 0.03, "square"]],
};

let ctx: AudioContext | null = null;

/** Play a sound at `volume` (0–1). Does nothing where audio isn't available. */
export function playSound(id: SoundId, volume: number): void {
  try {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor || volume <= 0) return;
    ctx ??= new Ctor();
    const now = ctx.currentTime;
    for (const [freq, start, length, type] of NOTES[id] ?? NOTES.chime) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      // A soft attack and a quick fade, so nothing clicks; quiet even at full volume.
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.18 * volume, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + length + 0.02);
    }
  } catch {
    // Audio not available.
  }
}
