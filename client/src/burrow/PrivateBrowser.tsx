import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PrivateBrowserInput, type PrivateBrowserStatus } from "../api";

const keys = ["Tab", "Shift+Tab", "Enter", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

/** Private response data only: never put frames or input in task state or storage. */
export default function PrivateBrowser({ token, taskId, visible }: { token: string; taskId: string; visible: boolean }) {
  const [status, setStatus] = useState<PrivateBrowserStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState("");
  const [text, setText] = useState("");
  const [key, setKey] = useState("Tab");
  const [inputUncertain, setInputUncertain] = useState(false);
  const [visibleTab, setVisibleTab] = useState(document.visibilityState !== "hidden");
  const root = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const lock = useRef(false);
  const alive = useRef(true);
  const takeover = useRef<string | null>(null);
  const [pending, setPending] = useState<"take_over" | "give_back" | null>(null);
  const erase = useCallback(() => { setFrame(""); setText(""); }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !root.current) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    alive.current = true;
    const visibility = () => { setVisibleTab(document.visibilityState !== "hidden"); };
    document.addEventListener("visibilitychange", visibility);
    return () => { alive.current = false; document.removeEventListener("visibilitychange", visibility); };
  }, []);

  const check = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const next = await api.privateBrowser(token, taskId, crypto.randomUUID(), { action: "status" });
      if (!alive.current) return;
      setStatus(next); setError("");
      if (["agent", "human", "input_uncertain"].includes(next.phase)) { setPending(null); takeover.current = null; }
      if (next.phase === "agent") setInputUncertain(false);
      if (next.phase === "input_uncertain") setInputUncertain(true);
      if (next.phase === "taking_over" && next.session_id) { takeover.current = next.session_id; setPending("take_over"); }
      if (next.phase !== "human") erase();
    } catch { if (alive.current) { setStatus(null); erase(); setError("Browser status unavailable. No connected browser or control is confirmed."); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [token, taskId, erase]);
  useEffect(() => { void check(); }, [check]);

  const human = status?.phase === "human" && !!status.session_id && !pending;
  const sessionId = status?.session_id;
  useEffect(() => {
    if (!human || !visible || !visibleTab || !onScreen || inputUncertain) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!lock.current) {
        lock.current = true;
        try {
          const next = await api.privateBrowser(token, taskId, crypto.randomUUID(), { action: "frame", session_id: sessionId! });
          if (!cancelled && alive.current) {
            setStatus(next);
            if (next.phase === "human" && next.session_id === sessionId && next.png) setFrame(next.png);
            else erase();
          }
        } catch { if (!cancelled && alive.current) { erase(); setError("Live view unavailable. Recheck browser status before interacting."); setStatus(null); } }
        finally { lock.current = false; }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [human, visible, visibleTab, onScreen, inputUncertain, sessionId, token, taskId, erase]);

  async function command(action: "take_over" | "give_back" | "input", input?: PrivateBrowserInput) {
    if (lock.current || (action === "input" && (!human || inputUncertain || !frame))) return;
    const session = status?.session_id;
    if (action !== "take_over" && !session) return;
    const id = action === "take_over" ? (takeover.current ??= crypto.randomUUID()) : crypto.randomUUID();
    lock.current = true; setBusy(true); setError("");
    if (action !== "input") { setPending(action); erase(); }
    else setText("");
    try {
      const next = await api.privateBrowser(token, taskId, id, { action, ...(action !== "take_over" ? { session_id: session! } : {}), ...(input ? { input } : {}) });
      if (!alive.current) return;
      setStatus(next);
      if (action !== "input" && (next.phase === "human" || next.phase === "agent")) { setPending(null); takeover.current = null; }
      if (action === "give_back") setInputUncertain(false);
      if (next.phase !== "human") erase();
    } catch {
      if (!alive.current) return;
      erase();
      if (action === "input") { setInputUncertain(true); setError("Input outcome unknown. Input has stopped and will not be retried. Recheck the status, then Give Back when ready."); }
      else setError(action === "give_back" ? "Give Back outcome unknown. Recheck status; Kikka has not been started by this view." : "Take Over outcome unknown. Recheck status or reconcile the same request.");
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }

  return <section ref={root} className="burrow-permission burrow-private-browser" aria-label="Private browser">
    <h2>Private browser</h2>
    <p>This is a remote view of the same browser. Kikka cannot read, type or capture while you control it. Give Back permits Kikka to observe the current page.</p>
    <p className="burrow-small">Frames and typed input are not saved to task messages or Materials. No clipboard access.</p>
    <p role="status">{pending ? `${pending === "take_over" ? "Take Over" : "Give Back"} not yet confirmed.` : status ? status.phase === "human" ? "You control the browser." : status.phase === "agent" ? "Browser control is with Kikka." : "Browser control is changing. Recheck status." : "Browser connection is not confirmed."}</p>
    {inputUncertain && <p role="status">Input outcome is unknown. Further input is disabled; it will not be retried.</p>}
    {error && <p className="burrow-error" role="alert">{error}</p>}
    <button className="burrow-secondary" disabled={busy} onClick={() => void check()}>Recheck browser status</button>
    {status?.phase === "agent" && !pending && <button className="burrow-primary" disabled={busy} onClick={() => void command("take_over")}>Take Over</button>}
    {pending === "take_over" && takeover.current && <button className="burrow-secondary" disabled={busy} onClick={() => void command("take_over")}>Reconcile Take Over</button>}
    {status?.session_id && ["human", "input_uncertain"].includes(status.phase) && pending !== "give_back" && <button className="burrow-primary" disabled={busy} onClick={() => void command("give_back")}>Give Back</button>}
    {human && !inputUncertain && visible && visibleTab && <>
      <button className="burrow-secondary burrow-browser-frame" aria-label="Remote browser view; use the key controls below for keyboard navigation" disabled={busy || !frame} onClick={event => {
        const image = event.currentTarget.querySelector("img");
        if (!image || !image.naturalWidth || event.detail === 0) return;
        const rect = image.getBoundingClientRect();
        const x = Math.floor((event.clientX - rect.left) * image.naturalWidth / rect.width);
        const y = Math.floor((event.clientY - rect.top) * image.naturalHeight / rect.height);
        if (x >= 0 && y >= 0 && x < image.naturalWidth && y < image.naturalHeight) void command("input", { kind: "click", x, y });
      }}>{frame ? <img src={`data:image/png;base64,${frame}`} alt="Private live browser" draggable={false} style={{ display: "block", maxWidth: "100%", height: "auto" }} /> : "Waiting for a live frame…"}</button>
      <form onSubmit={event => { event.preventDefault(); if (text) void command("input", { kind: "text", text }); }}>
        <label>Private text<input type="password" autoComplete="off" value={text} onChange={event => setText(event.target.value)} /></label>
        <button className="burrow-secondary" disabled={busy || !frame || !text}>Type in browser</button>
      </form>
      <label>Browser key<select value={key} onChange={event => setKey(event.target.value)}>{keys.map(value => <option key={value}>{value}</option>)}</select></label>
      <button className="burrow-secondary" disabled={busy || !frame} onClick={() => void command("input", { kind: "key", key })}>Send key</button>
      {[-1, 1].map(direction => <button className="burrow-secondary" key={direction} disabled={busy || !frame} onClick={() => void command("input", { kind: "scroll", x: 0, y: direction * 500 })}>Scroll {direction < 0 ? "up" : "down"}</button>)}
    </>}
  </section>;
}
