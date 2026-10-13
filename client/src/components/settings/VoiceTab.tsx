import { useEffect, useRef, useState } from "react";
import {
  MIN_SENSITIVITY_DB,
  VOICE_PREFS_EVENT,
  describeKey,
  levelToDb,
  loadVoicePrefs,
  rmsOf,
  saveVoicePrefs,
  type InputMode,
  type VoicePrefs,
} from "../../lib/voiceControls";

const METER_SAMPLE_MS = 60;

/** How far along the -100..0 dB scale a level sits, as a percentage. */
function percentOf(db: number): number {
  return Math.max(0, Math.min(100, ((db - MIN_SENSITIVITY_DB) / -MIN_SENSITIVITY_DB) * 100));
}

/**
 * Settings → Voice & video: voice activity or push to talk (with a recorded key), input
 * sensitivity with a live mic meter. Saved on this device, like Discord's; a call in progress
 * follows the change at once.
 */
export function VoiceTab() {
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs());
  const [recording, setRecording] = useState(false);
  const [checking, setChecking] = useState(false);
  const [level, setLevel] = useState(MIN_SENSITIVITY_DB);
  const [micError, setMicError] = useState<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const update = (next: VoicePrefs) => {
    setPrefs(next);
    saveVoicePrefs(next);
    window.dispatchEvent(new Event(VOICE_PREFS_EVENT));
  };

  // Recording the push to talk key: the next key pressed becomes it; Escape cancels. Listened
  // for first (capture, on window) so the key doesn't also act on Settings or the app.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setRecording(false);
      if (e.key === "Escape" || e.code === "Escape") return;
      const next = { ...prefsRef.current, pttKey: e.code };
      setPrefs(next);
      saveVoicePrefs(next);
      window.dispatchEvent(new Event(VOICE_PREFS_EVENT));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  // "Check my mic": a live level from a separate capture, stopped when done or on leaving.
  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: number | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        if (!cancelled) {
          setMicError("Ohiyo couldn't use your microphone. Check that it's allowed for this site or app.");
          setChecking(false);
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const Ctor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      void ctx.resume().catch(() => {});
      const samples = new Float32Array(analyser.fftSize);
      timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        setLevel(levelToDb(rmsOf(samples)));
      }, METER_SAMPLE_MS);
    })();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
      setLevel(MIN_SENSITIVITY_DB);
    };
  }, [checking]);

  const setMode = (inputMode: InputMode) => update({ ...prefs, inputMode });
  const keyLabel = describeKey(prefs.pttKey);
  const aboveThreshold = level >= prefs.sensitivityDb;
  const showSlider = prefs.inputMode === "voice" && !prefs.autoSensitivity;

  return (
    <div className="kc-voice-settings">
      <h2 className="mb-1 text-xl font-bold">Voice &amp; video</h2>
      <p className="mb-6 max-w-3xl text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        How your microphone works in calls. These settings are kept on this device.
      </p>

      <section className="kc-voice-section" aria-labelledby="kc-voice-mode-title">
        <h3 id="kc-voice-mode-title" className="kc-voice-section__title">Input mode</h3>
        <div className="kc-voice-options" role="radiogroup" aria-labelledby="kc-voice-mode-title">
          <label className={`kc-voice-option${prefs.inputMode === "voice" ? " kc-voice-option--on" : ""}`}>
            <input type="radio" name="kc-voice-input-mode" value="voice" checked={prefs.inputMode === "voice"} onChange={() => setMode("voice")} />
            <span className="kc-voice-option__name">Voice activity</span>
            <span className="kc-voice-option__hint">Your voice goes out whenever you speak.</span>
          </label>
          <label className={`kc-voice-option${prefs.inputMode === "ptt" ? " kc-voice-option--on" : ""}`}>
            <input type="radio" name="kc-voice-input-mode" value="ptt" checked={prefs.inputMode === "ptt"} onChange={() => setMode("ptt")} />
            <span className="kc-voice-option__name">Push to talk</span>
            <span className="kc-voice-option__hint">
              Your voice only goes out while you hold a key, and only while Ohiyo is the window you&apos;re using.
            </span>
          </label>
        </div>

        {prefs.inputMode === "ptt" && (
          <div className="kc-voice-key">
            <span className="kc-voice-key__label">Push to talk key</span>
            {recording ? (
              <span className="kc-voice-key__recording" role="status">Press a key… (Escape cancels)</span>
            ) : keyLabel ? (
              <kbd className="kc-voice-key__kbd">{keyLabel}</kbd>
            ) : (
              <span className="kc-voice-key__none">None yet</span>
            )}
            <button type="button" className="kc-voice-button" onClick={() => setRecording((r) => !r)}>
              {recording ? "Cancel" : keyLabel ? "Change" : "Set a key"}
            </button>
            {keyLabel && !recording && (
              <button type="button" className="kc-voice-button kc-voice-button--quiet" onClick={() => update({ ...prefs, pttKey: null })}>
                Clear
              </button>
            )}
            {!keyLabel && !recording && (
              <p className="kc-voice-note">Until you set a key, your voice goes out when you speak.</p>
            )}
          </div>
        )}
      </section>

      <section className="kc-voice-section" aria-labelledby="kc-voice-sensitivity-title">
        <h3 id="kc-voice-sensitivity-title" className="kc-voice-section__title">Input sensitivity</h3>
        {prefs.inputMode === "voice" ? (
          <label className="kc-voice-check">
            <input
              type="checkbox"
              checked={prefs.autoSensitivity}
              onChange={(e) => update({ ...prefs, autoSensitivity: e.target.checked })}
            />
            <span>Automatically determine input sensitivity</span>
          </label>
        ) : (
          <p className="kc-voice-note">Push to talk sends whatever the mic hears while you hold the key.</p>
        )}
        {showSlider && (
          <div className="kc-voice-slider">
            <input
              type="range"
              min={MIN_SENSITIVITY_DB}
              max={0}
              step={1}
              value={prefs.sensitivityDb}
              aria-label="Input sensitivity"
              aria-valuetext={`${prefs.sensitivityDb} dB`}
              onChange={(e) => update({ ...prefs, sensitivityDb: Number(e.target.value) })}
            />
            <span className="kc-voice-slider__value">{prefs.sensitivityDb} dB</span>
            <p className="kc-voice-note">Sound quieter than this is held back. Speak normally and move it until the bar goes green.</p>
          </div>
        )}

        <div className="kc-voice-meter-row">
          <button type="button" className="kc-voice-button" onClick={() => { setMicError(null); setChecking((c) => !c); }}>
            {checking ? "Stop checking" : "Check my mic"}
          </button>
          <div
            className="kc-voice-meter"
            data-testid="mic-meter"
            data-level={Math.round(level)}
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={MIN_SENSITIVITY_DB}
            aria-valuemax={0}
            aria-valuenow={Math.round(level)}
          >
            <div
              className={`kc-voice-meter__fill${showSlider && !aboveThreshold ? " kc-voice-meter__fill--held" : ""}`}
              style={{ transform: `scaleX(${percentOf(level) / 100})` }}
            />
            {showSlider && <div className="kc-voice-meter__mark" style={{ left: `${percentOf(prefs.sensitivityDb)}%` }} aria-hidden="true" />}
          </div>
        </div>
        {micError && <p className="kc-voice-note kc-voice-note--error" role="alert">{micError}</p>}
      </section>

      <section className="kc-voice-section" aria-labelledby="kc-voice-keys-title">
        <h3 id="kc-voice-keys-title" className="kc-voice-section__title">In a call</h3>
        <p className="kc-voice-note">
          <kbd className="kc-voice-key__kbd">Ctrl</kbd> + <kbd className="kc-voice-key__kbd">Shift</kbd> + <kbd className="kc-voice-key__kbd">M</kbd> mutes and
          {" "}<kbd className="kc-voice-key__kbd">Ctrl</kbd> + <kbd className="kc-voice-key__kbd">Shift</kbd> + <kbd className="kc-voice-key__kbd">D</kbd> deafens (⌘ instead of Ctrl on a Mac).
          Deafened, you hear nobody and your mic is off too.
        </p>
      </section>
    </div>
  );
}
