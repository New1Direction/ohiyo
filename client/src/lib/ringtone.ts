// A short, soft two-note ring made with WebAudio (no sound files), repeated until stopped.
// Used for an incoming DM call; silent where audio can't play (no AudioContext, or the
// browser hasn't allowed sound yet). How loud follows Settings → Notifications.

import type { SoundPrefs } from "./notificationSounds";

type AudioContextCtor = typeof AudioContext;

/** The ring's gain with the volume slider all the way up; the default 0.6 gives 0.18. */
const RING_FULL_VOLUME = 0.3;

/** How loud the ring is for these sound settings; `null` when it should be silent. */
export function ringVolume(prefs: Pick<SoundPrefs, "enabled" | "volume">): number | null {
  if (!prefs.enabled) return null;
  const volume = Math.min(1, Math.max(0, Number.isFinite(prefs.volume) ? prefs.volume : 0));
  if (volume === 0) return null;
  return Math.round(RING_FULL_VOLUME * volume * 1000) / 1000;
}

/** Start ringing; returns a function that stops it. */
export function startRingtone(volume = 0.18): () => void {
  const Ctx: AudioContextCtor | undefined =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctx) return () => {};
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return () => {};
  }
  let stopped = false;
  const ringOnce = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    // Two notes a fourth apart, twice, then a pause: a gentle "brr-brr".
    [0, 0.42].forEach((offset) => {
      [659.25, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = now + offset + i * 0.14;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(volume, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.14);
      });
    });
  };
  ringOnce();
  const timer = setInterval(ringOnce, 2200);
  return () => {
    stopped = true;
    clearInterval(timer);
    void ctx.close().catch(() => {});
  };
}
