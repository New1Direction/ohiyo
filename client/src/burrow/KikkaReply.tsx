import { useCallback, useEffect, useRef, useState } from "react";
import kikka from "../../../brand/kikka-chinchilla-clean.png";

type Activity = "ready" | "working" | "needs-you" | "stopped" | "error";
const activityLabels: Record<Activity, string> = {
  ready: "Right here with you", working: "Working on this", "needs-you": "Needs you", stopped: "Changes paused",
  error: "Needs attention",
};

// Presentation only: speech never starts, approves, stops, or changes a task.
export default function KikkaReply({ text, activity, revision }: { text: string; activity: Activity; revision: number }) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [playback, setPlayback] = useState<"quiet" | "starting" | "speaking">("quiet");
  const [error, setError] = useState("");
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (startTimer.current !== null) clearTimeout(startTimer.current);
    startTimer.current = null;
    if (!utterance.current) return;
    utterance.current = null; // Ignore delayed events from the previous reply.
    window.speechSynthesis.cancel();
  }, []);
  const stop = useCallback(() => { cancel(); setPlayback("quiet"); }, [cancel]);

  useEffect(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    const speech = window.speechSynthesis;
    const update = () => {
      // Never fall back to a remote or unspecified voice for private page content.
      const voices = speech.getVoices().filter(v => v.localService && /^en(?:[-_]|$)/i.test(v.lang));
      setVoice(voices.find(v => v.default) ?? voices[0] ?? null);
    };
    update();
    speech.addEventListener("voiceschanged", update);
    return () => speech.removeEventListener("voiceschanged", update);
  }, []);
  useEffect(() => {
    setPlayback("quiet"); setError("");
    return cancel;
  }, [text, activity, revision, cancel]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Let native keyboard activation reach the Stop button before its label changes.
      if (["Enter", " "].includes(event.key) && event.target instanceof HTMLElement && event.target.closest(".kikka-voice button")) return;
      if (event.key === "Escape" || (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(event.key)))) stop();
    };
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("keydown", keydown, true); document.removeEventListener("visibilitychange", hide); };
  }, [stop]);

  function read() {
    if (!voice || activity === "working") return;
    cancel(); setError("");
    const next = new window.SpeechSynthesisUtterance(text);
    next.voice = voice; next.lang = voice.lang;
    utterance.current = next;
    setPlayback("starting");
    const failed = () => {
      if (utterance.current !== next) return;
      stop(); setError("I couldn’t read that aloud. Your reply is still here.");
    };
    next.onstart = () => {
      if (utterance.current !== next) return;
      if (startTimer.current !== null) clearTimeout(startTimer.current);
      startTimer.current = null; setPlayback("speaking");
    };
    next.onend = () => { if (utterance.current === next) stop(); };
    next.onerror = failed;
    startTimer.current = setTimeout(failed, 8000);
    try { window.speechSynthesis.speak(next); } catch { failed(); }
  }

  const talking = playback !== "quiet";
  const status = playback === "speaking" ? "Reading aloud" : playback === "starting" ? "Getting voice ready…" : activityLabels[activity];
  return <div className={`kikka-reply ${activity} ${talking ? "talking" : ""}`}>
    <div className="kikka-reply-heading"><div className="kikka-presence" aria-hidden="true"><img src={kikka} alt="" /><i>{activity === "error" ? "!" : ""}</i></div><div><strong>Kikka</strong><span className="kikka-activity" role="status">{status}{activity === "working" && !talking && <span className="kikka-working-dots" aria-hidden="true"><i /><i /><i /></span>}</span></div></div>
    <p className="kikka-reply-text" role="status">{text}</p>
    <div className="kikka-voice"><button type="button" className="burrow-secondary" disabled={!talking && (!voice || activity === "working")} onClick={talking ? stop : read}>
      <span className="kikka-voice-mark" aria-hidden="true">{talking ? "■" : "♪"}</span>{talking ? "Stop talking" : "Read aloud"}
    </button><span>{talking ? "Or just start typing. Your work keeps going." : voice ? "Uses your device’s voice. Microphone off." : "Read aloud isn’t available on this device. You can still type."}</span></div>
    {error && <p className="kikka-voice-error" role="alert">{error}</p>}
  </div>;
}
