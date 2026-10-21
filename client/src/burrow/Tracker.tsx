import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, type BurrowTask, type LaunchAction, type LaunchPage, type LaunchResult } from "../api";
import KikkaReply from "./KikkaReply";
import { taskActionError } from "./taskLanguage";
import "./tracker.css";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export default function Tracker({ task, token, onUpdate, onDirtyChange }: {
  task: BurrowTask; token: string; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const result: LaunchResult = JSON.parse(task.result);
  const [draft, setDraft] = useState<LaunchPage | null>(null);
  const [draftVersion, setDraftVersion] = useState(task.version);
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [proofOpen, setProofOpen] = useState(false);
  const sending = useRef(false);
  const changedSection = useRef<string | null>(null);
  const page = draft ?? result.page;
  const complete = page.items.filter(i => i.done).length;
  const blocked = page.items.filter(i => !i.done && i.blocker.trim()).length;
  const percent = Math.round(complete / page.items.length * 100);
  const dirty = draft !== null;
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!changedSection.current) return;
    document.querySelector(changedSection.current)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    changedSection.current = null;
  }, [task.version]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function edit(next: LaunchPage) {
    if (!draft) setDraftVersion(task.version);
    setDraft(next); setError("");
  }
  async function change(action: LaunchAction) {
    if (sending.current) return;
    sending.current = true; setPending(true); setError("");
    try {
      const next = await api.changeLaunchTracker(token, action.type === "edit" ? { ...task, version: draftVersion } : task, action);
      if (action.type === "steer") {
        const changed = (JSON.parse(next.result) as LaunchResult).proof.changed;
        changedSection.current = changed.includes("Supplier costs") ? ".launch-costs" : changed.includes("Page layout") ? ".launch-items" : null;
      }
      onUpdate(next); setDraft(null);
      if (action.type === "steer") setInstruction(current => current === action.text ? "" : current);
    } catch (error) { setError(taskActionError(error, "Couldn’t confirm the change. Your text is still here; refresh before trying again.")); }
    finally { sending.current = false; setPending(false); }
  }
  function steer(event: FormEvent) {
    event.preventDefault(); if (instruction.trim() && !dirty) void change({ type: "steer", text: instruction });
  }
  function updateItem(index: number, fields: Partial<LaunchPage["items"][number]>) {
    edit({ ...page, items: page.items.map((item, i) => i === index ? { ...item, ...fields } : item) });
  }
  const suggestions = page.stopped ? ["Continue"] : [
    ...(page.costs === null || page.risks === null ? ["Add supplier costs and a risk section"] : ["Actually make the costs monthly"]),
    page.layout === "table" ? "Use cards instead" : "Use a table",
    page.simple ? "Show all details" : "Make it simpler",
    ...(page.extra_column === null ? ["Add one more column"] : []),
  ];
  return <article className="launch-workspace">
    <div className="launch-canvas">
    <header className="launch-heading"><div><p className="burrow-eyebrow">A LITTLE IDEA, TAKING SHAPE</p><h1>{page.title}</h1><p>Your people. Your plans. One place to move them forward.</p></div><span className="launch-saved" role="status">{pending ? "Changing it…" : dirty ? "Unsaved changes" : page.stopped ? "Stopped" : "✓ Saved"}</span></header>
    <div className="launch-tools">
      <button className="burrow-link" disabled={pending || dirty || !result.can_undo} onClick={() => void change({ type: "undo" })}>↶ Undo</button>
      <button className="burrow-link" disabled={pending || dirty} onClick={() => void change({ type: "fork" })}>Make a second version ↗</button>
      <button className="burrow-link" disabled={pending || dirty} onClick={() => void change({ type: "steer", text: page.stopped ? "continue" : "stop" })}>{page.stopped ? "Continue" : "Stop"}</button>
      <button className="burrow-secondary" aria-expanded={proofOpen} aria-controls="launch-proof" onClick={() => setProofOpen(!proofOpen)}>What did you check?</button>
    </div>
    {proofOpen && <section className="launch-proof" id="launch-proof"><p className="burrow-eyebrow">WHAT I CHECKED · LAST SAVED CHANGE</p>
      <h2>{result.proof.changed.length ? `Updated ${result.proof.changed.length} ${result.proof.changed.length === 1 ? "section" : "sections"}` : "No sections changed"}</h2>
      <p>{result.proof.changed.join(" · ")}</p><ul>{result.proof.checks.map(check => <li key={check}>✓ {check}</li>)}</ul>
      {result.page.costs !== null && <p>Known totals: {money(result.proof.monthly_cents)} monthly · {money(result.proof.once_cents)} one-time</p>}
      {result.proof.needs.length > 0 && <><strong>Still needs you</strong><ul>{result.proof.needs.map(need => <li key={need}>{need}</li>)}</ul></>}
      <p>These checks cover the saved page, not whether your launch is ready. No outside research was done.</p>
    </section>}
    {error && <p role="alert" className="burrow-error">{error}</p>}
    {page.stopped && <p className="launch-stopped">Changes are stopped. Your page is saved. Choose Continue when you’re ready.</p>}
    <div className="launch-stats"><div><span>THE BIG PICTURE</span><strong>{percent}% <small>complete</small></strong><progress value={complete} max={page.items.length} aria-label="Checklist progress" /></div><div><span>CHECKED OFF</span><strong>{complete}<small> / {page.items.length}</small></strong><p>One step at a time.</p></div><div><span>NEEDS A HAND</span><strong>{blocked}<small> {blocked === 1 ? "blocker" : "blockers"}</small></strong><p>{blocked ? "Let’s untangle these." : "Nothing flagged yet."}</p></div></div>
    <form className="launch-page" onSubmit={event => { event.preventDefault(); if (draft) void change({ type: "edit", page: draft }); }}>
      <fieldset disabled={pending || page.stopped}>
        <div className="launch-section-title"><div><p className="burrow-eyebrow">THE PATH TO LAUNCH</p><h2>Small steps. Real progress.</h2></div><button type="button" className="burrow-link" disabled={page.items.length >= 100} onClick={() => edit({ ...page, items: [...page.items, { title: "New step", owner: "", date: "", blocker: "", done: false, extra: "" }] })}>＋ Add a step</button></div>
        <div className={`launch-items ${page.layout} ${page.simple ? "simple" : ""} ${page.extra_column && !page.simple ? "with-extra" : ""}`}>
          {page.layout === "table" && <div className="launch-table-heading"><span>Step</span><span>Owner</span><span>Date</span>{!page.simple && <span>Blocker</span>}{page.extra_column && !page.simple && <span>{page.extra_column}</span>}</div>}
          {page.items.map((item, index) => <div className={`launch-item ${item.done ? "checked" : ""}`} key={index}>
            <div className="launch-item-name"><input aria-label={`Complete step ${index + 1}`} type="checkbox" checked={item.done} onChange={event => updateItem(index, { done: event.target.checked })} /><input aria-label={`Step ${index + 1}`} value={item.title} maxLength={500} onChange={event => updateItem(index, { title: event.target.value })} required /></div>
            <label><span>Owner</span><input aria-label={`Owner for step ${index + 1}`} value={item.owner} maxLength={500} placeholder="Who’s on it?" onChange={event => updateItem(index, { owner: event.target.value })} /></label>
            <label><span>Date</span><input aria-label={`Date for step ${index + 1}`} type="date" value={item.date} onChange={event => updateItem(index, { date: event.target.value })} /></label>
            {!page.simple && <label><span>Blocker</span><input aria-label={`Blocker for step ${index + 1}`} value={item.blocker} maxLength={500} placeholder="Anything in the way?" onChange={event => updateItem(index, { blocker: event.target.value })} /></label>}
            {page.extra_column && !page.simple && <label><span>{page.extra_column}</span><input aria-label={`${page.extra_column} for step ${index + 1}`} value={item.extra} maxLength={500} placeholder="Add a detail" onChange={event => updateItem(index, { extra: event.target.value })} /></label>}
          </div>)}
        </div>
        <div className="launch-lower">
          {page.costs !== null && <section className="launch-costs"><div className="launch-section-title"><h2>Supplier costs <small>USD</small></h2><button className="burrow-link" type="button" disabled={page.costs.length >= 100} onClick={() => edit({ ...page, costs: [...page.costs!, { title: "New cost", cents: null, period: "monthly" }] })}>＋ Add</button></div>
            <p className="burrow-small">Use your real costs. Blank amounts aren’t treated as estimates.</p>
            {page.costs.map((cost, index) => <div className="launch-cost" key={index}>
              <input aria-label={`Cost ${index + 1} name`} value={cost.title} required maxLength={500} onChange={event => edit({ ...page, costs: page.costs!.map((c, i) => i === index ? { ...c, title: event.target.value } : c) })} />
              <input aria-label={`Cost ${index + 1} amount in USD`} type="number" min="0" max="1000000000" step="0.01" placeholder="Amount" value={cost.cents === null ? "" : cost.cents / 100} onChange={event => edit({ ...page, costs: page.costs!.map((c, i) => i === index ? { ...c, cents: event.target.value === "" ? null : Math.round(Number(event.target.value) * 100) } : c) })} />
              <select aria-label={`Cost ${index + 1} frequency`} value={cost.period} onChange={event => edit({ ...page, costs: page.costs!.map((c, i) => i === index ? { ...c, period: event.target.value as "monthly" | "once" } : c) })}><option value="once">One-time</option><option value="monthly">Monthly</option></select>
            </div>)}
            <div className="launch-totals"><span>Known monthly total<strong>{money(page.costs.reduce((sum, c) => sum + (c.period === "monthly" ? c.cents ?? 0 : 0), 0))}</strong></span><span>Known one-time total<strong>{money(page.costs.reduce((sum, c) => sum + (c.period === "once" ? c.cents ?? 0 : 0), 0))}</strong></span></div>
            {page.costs.some(c => c.cents === null) && <p className="burrow-small">Some amounts are missing. These aren’t your full costs yet.</p>}
          </section>}
          {page.risks !== null && <section className="launch-risks"><div className="launch-section-title"><h2>Keep an eye on</h2><button className="burrow-link" type="button" disabled={page.risks.length >= 100} onClick={() => edit({ ...page, risks: [...page.risks!, "New risk"] })}>＋ Add a risk</button></div>
            {page.risks.length === 0 && <p>No risks listed yet. Add what could get in the way.</p>}
            {page.risks.map((risk, index) => <input key={index} aria-label={`Risk ${index + 1}`} required value={risk} maxLength={1000} onChange={event => edit({ ...page, risks: page.risks!.map((r, i) => i === index ? event.target.value : r) })} />)}
          </section>}
          <section className="launch-notes"><label htmlFor="launch-notes">Room for a thought</label><textarea id="launch-notes" placeholder="A decision, a loose end, a little inspiration…" value={page.notes} maxLength={8000} onChange={event => edit({ ...page, notes: event.target.value })} /></section>
        </div>
      </fieldset>
      {dirty && <div className="launch-save"><span>{draftVersion !== task.version ? "This page changed elsewhere. Copy your edits before discarding and reopening." : "Save your edits before asking for another change."}</span><button type="button" className="burrow-secondary" disabled={pending} onClick={() => { setDraft(null); setError(""); }}>Discard edits</button><button className="burrow-primary" disabled={pending}>Save changes</button></div>}
    </form>
    </div>
    <section className="launch-conversation" aria-label="Talk to Kikka">
      <KikkaReply revision={task.version} activity={pending ? "working" : error || dirty ? "needs-you" : page.stopped ? "stopped" : "ready"} text={pending ? "Saving your change…" : error || (dirty ? "Your edits are here. Save them when you’re ready, then we can keep shaping this." : result.reply)} />
      <p className="launch-last-ask">You: {result.instruction}</p>
      <form className="burrow-composer" onSubmit={steer}><label className="sr-only" htmlFor="launch-change">Tell Kikka what to change</label><textarea id="launch-change" rows={2} value={instruction} maxLength={2000} onChange={event => setInstruction(event.target.value)} placeholder="What should we change?" /><div><span>{dirty ? "Save your page edits first." : "Same page. Keep shaping it."}</span><button className="burrow-primary" disabled={pending || dirty || !instruction.trim()}>Change <span aria-hidden>↗</span></button></div></form>
      <div className="launch-suggestions">{suggestions.map(text => <button key={text} disabled={pending || dirty} onClick={() => void change({ type: "steer", text })}>{text} ↗</button>)}</div>
      <p className="burrow-small">This first tracker understands the suggestions above, plus stop, continue, undo that, and make a second version. No outside service is used. Your page is saved on this server, not end-to-end encrypted.</p>
    </section>
  </article>;
}
