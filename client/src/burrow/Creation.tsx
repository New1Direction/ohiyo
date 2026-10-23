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
  const [narrow, setNarrow] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(!!result.page);
  const [checks, setChecks] = useState(false);
  const sending = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const working = task.state === "working";
  const submitLabel = task.state === "failed" ? "Try again" : result.page ? "Send" : "Make it";
  const dirty = !!text.trim();
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [task.version]);
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
  function openChat() { setPreviewOpen(false); requestAnimationFrame(() => composer.current?.focus()); }
  return <article ref={selectionRoot} className={`creation-studio ${previewOpen ? "preview-open" : ""}`}>
    <SelectionActions root={selectionRoot} onQuote={!busy ? selected => {
      const next = `${text}${text ? "\n\n" : ""}${selected.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
      if (next.length > 8000) { setError("There isn’t enough room for this quote. Shorten your selection or your draft; nothing was replaced."); return; }
      setText(next); openChat();
    } : undefined} />
    <header className="creation-toolbar"><div><h1>{result.page?.title ?? task.request}</h1><span role="status">{working ? "Kikka is making changes…" : task.state === "failed" ? "Needs attention" : result.example ? "Example · saved for you" : result.page ? "Saved for you" : "Ready when you are"}</span></div><div className="creation-toolbar-actions">{previewOpen && <button className="burrow-secondary" onClick={openChat}>Conversation</button>}<button className="burrow-secondary" aria-expanded={previewOpen} aria-controls="creation-preview" onClick={() => setPreviewOpen(!previewOpen)}>Preview</button>{working ? <button className="burrow-secondary" disabled={busy} onClick={() => void act("stop")}>Stop</button> : <button className="burrow-secondary" disabled={busy || dirty || !result.can_undo} onClick={() => void act("undo")}>↶ Undo</button>}<button className="burrow-secondary" aria-expanded={checks} aria-controls="creation-checks" onClick={() => setChecks(!checks)}>Checks</button></div></header>
    {checks && <section id="creation-checks" className="creation-checks"><h2>What’s checked</h2><p>{result.page ? `${Object.keys(result.page.spec.elements).length} page parts checked for supported controls, valid fields and connected layout. Quiz answers and story paths are checked for valid references.` : "Checks appear after a page is made."}</p><p>These are structural checks, not a fact-check or a test of every interaction. Nothing is published or sent.</p></section>}
    <div className="creation-layout">
      <section className="creation-chat" id="creation-chat" aria-label="Conversation">
        <div className="creation-messages" ref={messages} role="log" aria-label="Conversation with Kikka" aria-live="polite">{result.messages.map((message, i) => <div key={i} className={`creation-message ${message.role}`}><strong>{message.role === "user" ? "You" : "Kikka"}</strong><p data-selection-content>{message.text}</p></div>)}{working && <p role="status" className="creation-working">Making your page. You can keep using your last saved version.</p>}</div>
        {(error || task.error) && <p role="alert" className="burrow-error">{error || `Kikka couldn’t finish this change. ${result.page ? "Your last saved page" : "Your request"} is still here. A previous attempt may already have cost money.`}</p>}
        {!canRun && <p className="creation-connection">Personal creation isn’t connected here yet. You can try the examples; your own requests stay saved.</p>}
        <form className="creation-composer" onSubmit={e => { e.preventDefault(); if (!busy && !working && canRun && (task.state !== "draft_ready" || text.trim())) void act("make"); }}><label className="sr-only" htmlFor="creation-message">{result.page ? "Ask Kikka for a change" : "Add details for Kikka"}</label><textarea id="creation-message" ref={composer} value={text} onChange={e => setText(e.target.value)} maxLength={8000} rows={3} placeholder={result.page ? "Make it more playful. Add a quiz. Try another layout…" : "Add your notes or a little more detail…"} onKeyDown={submitPromptOnEnter} aria-describedby="creation-send-hint" />
          <div><span id="creation-send-hint">Enter to send · Shift+Enter for a new line</span><button type="submit" className="burrow-primary" disabled={busy || working || !canRun || (task.state === "draft_ready" && !text.trim())}>{busy ? "Sending…" : working ? "Making…" : submitLabel}<span aria-hidden="true">↑</span></button></div>
        </form>
        {canRun && <p className="creation-consent">{submitLabel} shares your request and this page with {service}. Each attempt may cost money. No Ohiyo chats are included.</p>}
      </section>
      <section className="creation-preview" id="creation-preview" hidden={!previewOpen} aria-label="Page preview"><header><strong>Preview</strong><div role="group" aria-label="Preview width"><button aria-pressed={!narrow} onClick={() => setNarrow(false)}>Full width</button><button aria-pressed={narrow} onClick={() => setNarrow(true)}>Narrow</button></div><span>{result.example ? "EXAMPLE" : "NOT PUBLISHED"}</span></header>
        {result.example && <p className="creation-example-note">Ready-made example. {canRun ? "Ask Kikka to make it yours." : "Personal creation needs Kikka to be connected."}</p>}
        <div className={`creation-preview-scroll ${narrow ? "narrow" : ""}`}>{result.page ? <GeneratedPage key={JSON.stringify(result.page)} value={result.page} /> : <div className="creation-empty"><span aria-hidden="true">✦</span><h2>{working ? "A little idea, taking shape." : "Your idea goes here."}</h2><p>{working ? "Your page will appear here when it’s ready." : canRun ? "Return to the conversation and choose Make it to start." : "Your request is saved. Personal creation isn’t connected on this server yet."}</p><button className="burrow-secondary" onClick={openChat}>Back to conversation</button></div>}</div>
        <footer>Saved on this server, not end-to-end encrypted. Preview progress resets when you leave this creation or its page changes, not when you hide the preview.</footer>
      </section>
    </div>
  </article>;
}
