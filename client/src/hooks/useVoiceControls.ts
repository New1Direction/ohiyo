import { useCallback, useEffect, useRef, useState } from "react";
import {
  PTT_IDLE,
  PTT_TAIL_MS,
  VAD_CLOSED,
  VOICE_PREFS_EVENT,
  VOICE_PREFS_KEY,
  callShortcutFor,
  describeKey,
  levelToDb,
  loadVoicePrefs,
  pttKeyApplies,
  pttOpen,
  pttPress,
  pttRelease,
  rmsOf,
  transmitGateOpen,
  vadStep,
  type InputMode,
  type VoicePrefs,
} from "../lib/voiceControls";

/** The parts of a call engine (mesh or LiveKit) the voice controls drive. */
type Engine = {
  callState: string;
  localStream: MediaStream | null;
  toggleAudio: () => unknown;
  toggleDeafen: () => unknown;
  setTransmitGate: (open: boolean) => void;
};

export type PushToTalkStatus = { keyLabel: string; transmitting: boolean };

const VAD_SAMPLE_MS = 50;

function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Push to talk counts only once a key is set; until then the mic works by voice activity. */
function effectiveMode(p: VoicePrefs): InputMode {
  return p.inputMode === "ptt" && p.pttKey ? "ptt" : "voice";
}

/**
 * Applies this device's voice settings to a call: push to talk (with a short tail after the
 * key is let go), input sensitivity (measured on a copy of the mic, so a closed gate still
 * hears you start talking), and Ctrl/⌘+Shift+M / Ctrl/⌘+Shift+D to mute and deafen. Push to
 * talk works while Ohiyo is the focused window; a key held in another app isn't seen.
 */
export function useVoiceControls(engine: Engine): { prefs: VoicePrefs; pushToTalk: PushToTalkStatus | null } {
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs());
  const [transmitting, setTransmitting] = useState(false);
  const inCall = engine.callState !== "idle";
  const mode = effectiveMode(prefs);

  const engineRef = useRef(engine);
  engineRef.current = engine;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const pttRef = useRef(PTT_IDLE);
  const vadRef = useRef(VAD_CLOSED);
  const vadOpenRef = useRef(false);
  const tailTimerRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const p = prefsRef.current;
    engineRef.current.setTransmitGate(
      transmitGateOpen({
        inputMode: effectiveMode(p),
        pttOpen: pttOpen(pttRef.current, performance.now()),
        autoSensitivity: p.autoSensitivity,
        vadOpen: vadOpenRef.current,
      }),
    );
  }, []);

  // Follow the settings when they change (Settings → Voice & video, or another tab).
  useEffect(() => {
    const reload = () => setPrefs(loadVoicePrefs());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === VOICE_PREFS_KEY) reload();
    };
    window.addEventListener(VOICE_PREFS_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(VOICE_PREFS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    recompute();
  }, [prefs, recompute]);

  // Push to talk keys, only during a call.
  useEffect(() => {
    if (!inCall || mode !== "ptt") {
      pttRef.current = PTT_IDLE;
      setTransmitting(false);
      recompute();
      return;
    }
    const key = prefs.pttKey;
    const clearTail = () => {
      if (tailTimerRef.current !== null) window.clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    };
    const press = () => {
      clearTail();
      if (pttRef.current.held) return;
      pttRef.current = pttPress(pttRef.current);
      setTransmitting(true);
      recompute();
    };
    const release = () => {
      if (!pttRef.current.held) return;
      pttRef.current = pttRelease(pttRef.current, performance.now());
      recompute();
      clearTail();
      tailTimerRef.current = window.setTimeout(() => {
        tailTimerRef.current = null;
        setTransmitting(false);
        recompute();
      }, PTT_TAIL_MS);
    };
    const onDown = (e: KeyboardEvent) => {
      if (!pttKeyApplies(e, key, e.target as Element | null)) return;
      // A focused button would otherwise act on Space or Enter.
      e.preventDefault();
      press();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === key) release();
    };
    const onLeave = () => release();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTail();
      pttRef.current = PTT_IDLE;
    };
  }, [inCall, mode, prefs.pttKey, recompute]);

  // Input sensitivity: measure the mic and open the gate only above the chosen level.
  const micTrack = engine.localStream?.getAudioTracks().find((t) => t.readyState === "live") ?? null;
  useEffect(() => {
    const manual = inCall && mode === "voice" && !prefs.autoSensitivity;
    vadRef.current = VAD_CLOSED;
    if (!manual || !micTrack) {
      vadOpenRef.current = false;
      recompute();
      return;
    }
    const Ctor =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      // Nothing to measure with: never silence someone because of it.
      vadOpenRef.current = true;
      recompute();
      return;
    }
    const copy = micTrack.clone();
    copy.enabled = true;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(new MediaStream([copy]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    void ctx.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    const threshold = prefs.sensitivityDb;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const next = vadStep(vadRef.current, levelToDb(rmsOf(samples)), performance.now(), threshold);
      vadRef.current = next;
      if (next.open !== vadOpenRef.current) {
        vadOpenRef.current = next.open;
        recompute();
      }
    }, VAD_SAMPLE_MS);
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      copy.stop();
      void ctx.close().catch(() => {});
    };
  }, [inCall, mode, prefs.autoSensitivity, prefs.sensitivityDb, micTrack, recompute]);

  // Ctrl/⌘+Shift+M and Ctrl/⌘+Shift+D during a call; the modifiers make them safe while typing.
  useEffect(() => {
    if (!inCall) return;
    const mac = isMacLike();
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const action = callShortcutFor(e, mac);
      if (!action) return;
      e.preventDefault();
      if (action === "toggle-mute") void engineRef.current.toggleAudio();
      else void engineRef.current.toggleDeafen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inCall]);

  const pushToTalk: PushToTalkStatus | null =
    inCall && prefs.inputMode === "ptt" ? { keyLabel: describeKey(prefs.pttKey), transmitting: mode === "ptt" && transmitting } : null;
  return { prefs, pushToTalk };
}
