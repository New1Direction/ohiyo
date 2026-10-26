import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type BurrowTask } from "../api";
import GeneratedPage from "./GeneratedPage";
import { taskActionError } from "./taskLanguage";
import SelectionActions from "./SelectionActions";
import { submitPromptOnEnter } from "./promptKeys";
import "./creation.css";

type Result = { page: { title: string; spec: { elements: Record<string, unknown> } } | null; messages: { role: string; text: string }[]; can_undo: boolean; example: boolean };

export default function Creation({ task, token, canRun, service, onUpdate, onDirtyChange }: { task: BurrowTask; token: string; canRun: boolean; service: string | null; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void }) {
  const selectionRoot = useRef<HTMLElement>(null);
  const result = JSON.parse(task.result) as Result;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const latestMessage = useRef<HTMLDivElement>(null);
  const seenVersion = useRef(task.version);
  const working = task.state === "working";
  const submitLabel = task.state === "failed" ? "Try again" : result.page ? "Send" : "Allow & create";
  const dirty = !!text.trim();
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (seenVersion.current === task.version) return;
    seenVersion.current = task.version;
    latestMessage.current?.scrollIntoView({ block: "start" });
  }, [task.version]);
  async function act(action: "make" | "undo" | "stop") {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    const instruction = text;
    try {
      const next = action === "make" ? await api.makeBurrowPage(token, task, instruction.trim() || undefined) : await api.changeBurrowPage(token, task, action);
      onUpdate(next);
      if (action === "make") setText(current => current === instruction ? "" : current);
    } catch (e) { setError(taskActionError(e, "Couldn’t confirm the change. Your message is still here; refresh before trying again.")); }
    finally { sending.current = false; setBusy(false); }
  }
  const page = result.page && <section className="creation-page" aria-label="Interactive page">
    <header><span>{result.example ? "Example · try it here" : "Saved for you"}</span>{working ? <button className="burrow-secondary" disabled={busy} onClick={() => void act("stop")}>Stop</button> : <button className="burrow-secondary" disabled={busy || dirty || !result.can_undo} onClick={() => void act("undo")}>Undo change</button>}</header>
    <GeneratedPage key={JSON.stringify(result.page)} value={result.page} />
    <details className="creation-checks"><summary>About this page</summary><p>Made with supported controls. These checks do not verify facts or every interaction. Review the content before sharing. Nothing is published or installed.</p><p>Saved in Burrow, not end-to-end encrypted. Interactive progress resets when you leave this chat or the page changes.</p></details>
  </section>;
  return <article ref={selectionRoot} className="creation-studio" aria-label="Conversation with Kikka">
    <SelectionActions root={selectionRoot} onQuote={!busy ? selected => {
      const next = `${text}${text ? "\n\n" : ""}${selected.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
      if (next.length > 8000) { setError("There isn’t enough room for this quote. Shorten your selection or your message; nothing was replaced."); return; }
      setText(next); requestAnimationFrame(() => composer.current?.focus());
    } : undefined} />
    <div className="creation-thread" role="region" aria-label="Messages">
        {result.messages.map((message, i) => <div key={i} ref={i === result.messages.length - 1 ? latestMessage : undefined} className={`creation-message ${message.role}`}><strong>{message.role === "user" ? "You" : "Kikka"}</strong><p data-selection-content>{message.text}</p></div>)}
        {page}
        {working && <p role="status" className="creation-working">Making your page. You can keep using your last saved version.</p>}
        {(error || task.error) && <p role="alert" className="burrow-error">{error || `Kikka couldn’t finish this change. ${result.page ? "Your last saved page" : "Your request"} is still here. A previous attempt may already have cost money.`}</p>}
        {!result.page && <section className="creation-permission" aria-label="Page permission"><h2>{working ? "Making your page…" : "Let’s make an interactive page."}</h2><p>{working ? "You can stop this request. An attempt may already have cost money." : canRun ? "Your request is saved. Choose Allow & create to share it with your AI service. You can add more detail below first." : "Your request is saved. Page creation isn’t connected for this account yet."}</p>{working && <button className="burrow-secondary" disabled={busy} onClick={() => void act("stop")}>Stop</button>}</section>}
    </div>
        <form className="creation-composer" onSubmit={e => { e.preventDefault(); if (!busy && !working && canRun && (task.state !== "draft_ready" || text.trim())) void act("make"); }}><label className="sr-only" htmlFor="creation-message">{result.page ? "Ask Kikka for a change" : "Add details for Kikka"}</label><textarea id="creation-message" ref={composer} value={text} onChange={e => setText(e.target.value)} maxLength={8000} rows={3} placeholder={result.page ? "Make it more playful. Add a quiz. Try another layout…" : "Add your notes or a little more detail…"} onKeyDown={submitPromptOnEnter} aria-describedby="creation-send-hint" />
          <div><span id="creation-send-hint">Enter to send · Shift+Enter for a new line</span><button type="submit" className="burrow-primary" disabled={busy || working || !canRun || (task.state === "draft_ready" && !text.trim())}>{busy ? "Sending…" : working ? "Making…" : submitLabel}<span aria-hidden="true">↑</span></button></div>
          <p className="creation-consent">{canRun ? <>{submitLabel} shares your request and this page with {service}. Each attempt may cost money. No Ohiyo chats are included.</> : <>AI page creation isn’t available for this account.{result.page && " You can still use this page."}</>}</p>
        </form>
  </article>;
}
