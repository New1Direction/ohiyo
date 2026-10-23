import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, type ResearchChange, type ResearchSnapshot, type ResearchWorkspace as Workspace } from "../api";
import { apiStatus } from "../lib/apiErrors";
import Comparison from "./ResearchComparison";

type Draft = { version: number; change: ResearchChange };
const date = (value: number) => new Date(value * 1000).toLocaleString();

// Revision order, not arrival order: a late earlier answer stays in history.
function latestComparison(items: ResearchSnapshot[]) {
  return items.reduce<ResearchSnapshot | undefined>((latest, item) => !latest || (item.requirements_revision ?? -1) >= (latest.requirements_revision ?? -1) ? item : latest, undefined);
}

export default function ResearchWorkspace({ enabled, hasManualEdits, token, taskId, canUpdate, running, onResearch, onDirtyChange, children }: {
  enabled: boolean; hasManualEdits: boolean; token: string; taskId: string; canUpdate: boolean; running: boolean;
  onResearch: (revision: number) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void; children?: ReactNode;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<"brief" | "compare" | "decision">("compare");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [filter, setFilter] = useState("");
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const [sort, setSort] = useState<"source" | "name">("source");
  const [selected, setSelected] = useState<string | null>(null);
  const editor = useRef<HTMLFormElement>(null);
  const initialized = useRef(false);
  useLayoutEffect(() => { onDirtyChange(!!draft); return () => onDirtyChange(false); }, [draft, onDirtyChange]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = async () => {
      try {
        const next = await api.researchWorkspace(token, taskId);
        if (alive) {
          if (!initialized.current) { initialized.current = true; if (!next.comparisons.length) setTab("brief"); }
          setWorkspace(current => !current || next.version >= current.version ? next : current);
        }
      } catch { if (alive) setError("Couldn’t refresh the saved workspace. Displayed records may be out of date."); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, token, taskId]);
  function edit(change: ResearchChange) {
    if (!workspace || busy || draft) return;
    setDraft({ version: workspace.version, change }); setError(""); setNotice(""); setConflict(false);
    requestAnimationFrame(() => { editor.current?.scrollIntoView({ block: "nearest" }); editor.current?.querySelector<HTMLElement>("textarea, input")?.focus(); });
  }
  async function save() {
    if (!draft || busy) return;
    setBusy(true); setError("");
    try {
      const next = await api.saveResearchWorkspace(token, taskId, draft.version, draft.change);
      setWorkspace(current => !current || next.version >= current.version ? next : current);
      setNotice(draft.change.action === "brief" ? "Brief saved. No research started; earlier results keep their original basis." : draft.change.action === "decision" ? "Decision saved with its original comparison and evidence. Nothing was purchased." : "Your changes are saved.");
      setDraft(null); setConflict(false);
    } catch (e) {
      setConflict(apiStatus(e) === 409);
      setError(apiStatus(e) === 409 ? "The saved workspace changed. Your draft is still here. Review the latest saved records before applying it." : apiStatus(e) === 400 ? "This draft exceeds a field limit. Shorten it before saving; symbols and emoji can take more space than letters." : "Couldn’t confirm the save. Your draft is still here; check saved records before retrying.");
    } finally { setBusy(false); }
  }
  async function reviewLatest() {
    setBusy(true);
    try { const next = await api.researchWorkspace(token, taskId); setWorkspace(next); setDraft(current => current ? { ...current, version: next.version } : null); setConflict(false); setError(""); setNotice("Latest saved records loaded. Review them below, then save your draft if it should replace those fields."); }
    catch { setError("Couldn’t load the latest saved records. Your draft is unchanged."); }
    finally { setBusy(false); }
  }
  if (!enabled) return children;
  if (!workspace) return <><p className="burrow-small" role="status">{error || "Loading saved workspace…"}</p>{children}</>;
  const latest = latestComparison(workspace.comparisons);
  const recent = workspace.comparisons[workspace.comparisons.length - 1];
  const snapshot = workspace.comparisons.find(c => c.id === selected) ?? latest;
  const candidate = (id: string | undefined) => workspace.candidates.find(c => c.id === id);
  const options = snapshot?.comparison.options.filter(o => (!shortlistOnly || candidate(o.id)?.shortlisted) && o.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  if (sort === "name") options.sort((a, b) => a.name.localeCompare(b.name));
  const absent = workspace.candidates.filter(c => !snapshot?.comparison.options.some(o => o.id === c.id) && (c.shortlisted || c.note));
  const current = snapshot?.requirements_revision === workspace.brief.revision;
  const change = draft?.change;
  const draftValid = !!change && (change.action === "brief" ? !!change.text.trim() : change.action === "decision" ? !!change.rationale.trim() : change.action === "contribution" ? !!change.label.trim() : true);
  return <div className="research-workspace">
    <nav className="research-workspace-tabs" aria-label="Research workspace">
      {(["brief", "compare", "decision"] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === "brief" ? "Brief" : t === "compare" ? "Compare" : "Decision"}</button>)}
    </nav>
    {error && <p role="alert" className="burrow-error">{error}</p>}
    {notice && <p role="status" className="research-notice">{notice}</p>}
    {draft && <form ref={editor} className="research-workspace-editor" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy}>
      <h3>{change?.action === "brief" ? "Edit your brief" : change?.action === "candidate" ? `Your notes · ${candidate(change.candidate_id)?.name}` : change?.action === "decision" ? "Record your decision" : "Question or next step"}</h3>
      {change?.action === "brief" && <>
        <label>Requirements<textarea rows={5} maxLength={6000} value={change.text} onChange={e => setDraft({ ...draft, change: { ...change, text: e.target.value } })} /></label>
        <label>Item budget · optional<input maxLength={500} placeholder="For example: up to CAD 1,200 including tax" value={change.purchase_budget} onChange={e => setDraft({ ...draft, change: { ...change, purchase_budget: e.target.value } })} /></label>
        <p className="burrow-small">This is what you want to spend on the item, not permission to purchase or increase Kikka’s research allowance.</p>
      </>}
      {change?.action === "candidate" && <>
        <label>Personal note<textarea rows={3} maxLength={4000} value={change.note} onChange={e => setDraft({ ...draft, change: { ...change, note: e.target.value } })} /></label>
        <label className="research-check"><input type="checkbox" checked={change.shortlisted} onChange={e => setDraft({ ...draft, change: { ...change, shortlisted: e.target.checked } })} />Keep on my shortlist</label>
      </>}
      {change?.action === "contribution" && <>
        <label>Question or next step<input maxLength={200} value={change.label} onChange={e => setDraft({ ...draft, change: { ...change, label: e.target.value } })} /></label>
        <label>Your answer or notes<textarea rows={3} maxLength={4000} value={change.answer} onChange={e => setDraft({ ...draft, change: { ...change, answer: e.target.value } })} /></label>
        <label className="research-check"><input type="checkbox" checked={change.done} onChange={e => setDraft({ ...draft, change: { ...change, done: e.target.checked } })} />Resolved</label>
      </>}
      {change?.action === "decision" && <>
        <p>{candidate(change.candidate_id)?.name} · Based on the comparison you selected. Later research won’t rewrite this record.</p>
        <label>Why this fits<textarea rows={3} maxLength={4000} value={change.rationale} onChange={e => setDraft({ ...draft, change: { ...change, rationale: e.target.value } })} /></label>
        <label>Tradeoffs I accept<textarea rows={2} maxLength={4000} value={change.tradeoffs} onChange={e => setDraft({ ...draft, change: { ...change, tradeoffs: e.target.value } })} /></label>
        <label>What is still uncertain<textarea rows={2} maxLength={4000} value={change.uncertainties} onChange={e => setDraft({ ...draft, change: { ...change, uncertainties: e.target.value } })} /></label>
      </>}
      <div className="research-workspace-actions"><button type="button" className="burrow-secondary" disabled={busy} onClick={() => { setDraft(null); setConflict(false); setError(""); }}>Cancel draft</button>{conflict ? <button type="button" className="burrow-secondary" disabled={busy} onClick={() => void reviewLatest()}>Load latest for review</button> : <button className="burrow-primary" disabled={busy || !draftValid}>{busy ? "Saving…" : "Save to workspace"}</button>}</div>
    </fieldset></form>}
    <section hidden={tab !== "brief"} aria-label="Saved brief">
      <header className="research-workspace-heading"><div><p className="burrow-eyebrow">BRIEF {workspace.brief.revision}</p><h2>What matters to you</h2></div><button className="burrow-secondary" disabled={!!draft || busy} onClick={() => edit({ action: "brief", text: workspace.brief.text, purchase_budget: workspace.brief.purchase_budget })}>Edit brief</button></header>
      <p className="research-preserved-text">{workspace.brief.text}</p>
      <p className="burrow-small">Item budget: {workspace.brief.purchase_budget || "Not specified"}</p>
      {latest?.requirements_revision !== workspace.brief.revision && <div className="research-basis"><p>{latest ? "The saved comparison does not use this brief revision." : "No comparison is saved for this brief yet."}</p><p className="burrow-small">{running ? "Research is still running. You can save changes now and request an update after it finishes." : "Saving this brief doesn’t start research. Updates use the original task’s remaining allowance and approved pages."}</p>{canUpdate && <button className="burrow-secondary" disabled={busy || !!draft} onClick={() => { setBusy(true); void onResearch(workspace.brief.revision).then(ok => { if (ok) setNotice("Update requested under the existing allowance. The execution status shows whether Kikka has accepted it."); }).finally(() => setBusy(false)); }}>Allow research update · brief {workspace.brief.revision}</button>}</div>}
      <section className="research-contributions"><header className="research-workspace-heading"><h3>Questions & next steps</h3><button className="burrow-link" disabled={!!draft || busy} onClick={() => edit({ action: "contribution", label: "", answer: "", done: false })}>Add a question</button></header>
        {workspace.contributions.length ? workspace.contributions.map(c => <div className="research-contribution" key={c.id}><strong>{c.done ? "✓ " : "○ "}{c.label}</strong><p className="research-preserved-text">{c.answer || "No answer saved yet."}</p><button className="burrow-link" disabled={!!draft || busy} onClick={() => edit({ action: "contribution", ...c })}>Edit question</button></div>) : <p className="burrow-small">Keep your open questions and answers here. They won’t be replaced by a new comparison.</p>}
      </section>
      {workspace.briefs.length > 1 && <details className="burrow-request-details"><summary>Earlier briefs</summary>{workspace.briefs.slice(0, -1).reverse().map(b => <section key={b.revision}><h3>Brief {b.revision} · {date(b.created_at)}</h3><p className="research-preserved-text">{b.text}</p><p className="burrow-small">Item budget: {b.purchase_budget || "Not specified"}</p></section>)}</details>}
    </section>
    <section hidden={tab !== "compare"} aria-label="Saved comparisons">
      {recent && recent.requirements_revision === null && recent.id !== snapshot?.id && <div className="research-basis"><p>A newer result has no recorded requirements basis. It hasn’t replaced your attributed comparison.</p><button className="burrow-secondary" onClick={() => setSelected(recent.id)}>Review unversioned result</button></div>}
      {snapshot ? <>
        <div className={`research-basis${current ? "" : " research-basis-earlier"}`}><strong>{snapshot.requirements_revision === null ? "Requirements basis unrecorded" : `Uses brief ${snapshot.requirements_revision}${current ? " · current requirements" : " · earlier requirements"}`}</strong><p className="burrow-small">Saved {date(snapshot.created_at)}{snapshot.id !== latest?.id ? " · Earlier comparison" : ""}. Sources retain their own capture times.</p></div>
        <div className="research-comparison-tools"><label className="sr-only" htmlFor="research-option-filter">Filter options</label><input id="research-option-filter" placeholder="Find an option…" value={filter} onChange={e => setFilter(e.target.value)} /><button className="burrow-secondary" aria-pressed={shortlistOnly} onClick={() => setShortlistOnly(!shortlistOnly)}>Shortlist ({workspace.candidates.filter(c => c.shortlisted).length})</button><button className="burrow-link" onClick={() => setSort(sort === "name" ? "source" : "name")}>{sort === "name" ? "Order: A–Z" : "Order: research"}</button></div>
        {options.length ? <Comparison value={{ ...snapshot.comparison, options }} renderActions={option => {
          const c = candidate(option.id);
          if (!c) return null;
          return <div className="research-candidate-notes"><p className="burrow-small">{c.shortlisted ? "★ On your shortlist" : "Not shortlisted"}</p>{c.note && <p className="research-preserved-text">{c.note}</p>}<div className="research-workspace-actions"><button className="burrow-secondary" disabled={!!draft || busy} onClick={() => edit({ action: "candidate", candidate_id: c.id, note: c.note, shortlisted: c.shortlisted })}>Notes & shortlist</button><button className="burrow-link" disabled={!!draft || busy} onClick={() => { setTab("decision"); edit({ action: "decision", candidate_id: c.id, comparison_id: snapshot.id, rationale: "", tradeoffs: "", uncertainties: "" }); }}>Choose this option</button></div></div>;
        }} /> : <p className="burrow-small">No options match these filters. Your saved records are unchanged.</p>}
      </> : <><p className="burrow-small">No structured comparison saved yet. Your brief and contributions are ready to use.</p>{children}</>}
      {snapshot && hasManualEdits && <details className="burrow-request-details"><summary>Your edited document · separate from captured evidence</summary>{children}</details>}
      {!!absent.length && <details className="burrow-request-details"><summary>Preserved notes & shortlist from other comparisons ({absent.length})</summary>{absent.map(c => <section key={c.id}><h3>{c.name}{c.shortlisted ? " · Shortlisted" : ""}</h3><p className="research-preserved-text">{c.note || "No personal note."}</p><button className="burrow-link" disabled={!!draft || busy} onClick={() => edit({ action: "candidate", candidate_id: c.id, note: c.note, shortlisted: c.shortlisted })}>Edit preserved note</button></section>)}</details>}
      {workspace.comparisons.length > 1 && <details className="burrow-request-details"><summary>Saved comparisons ({workspace.comparisons.length})</summary>{workspace.comparisons.slice().reverse().map(c => <button className="research-history-item burrow-link" key={c.id} aria-pressed={snapshot?.id === c.id} onClick={() => setSelected(c.id)}>{c.id === latest?.id ? "Latest · " : ""}{c.requirements_revision === null ? "Unrecorded brief" : `Brief ${c.requirements_revision}`} · {date(c.created_at)}</button>)}</details>}
    </section>
    <section hidden={tab !== "decision"} aria-label="Saved decisions">
      <h2>Your decision, with its reasons</h2><p className="burrow-small">A personal record, not an order. Choose an option in Compare to record a decision.</p>
      {workspace.decisions.length ? workspace.decisions.slice().reverse().map((d, index) => {
        const basis = workspace.comparisons.find(c => c.id === d.comparison_id);
        const option = basis?.comparison.options.find(c => c.id === d.candidate_id);
        const changed = d.requirements_revision !== workspace.brief.revision || d.comparison_id !== latest?.id || (recent?.requirements_revision === null && d.comparison_id !== recent.id);
        return <section key={d.id} className="research-decision"><p className="burrow-eyebrow">{index === 0 ? "LATEST DECISION" : "EARLIER DECISION"} · {date(d.created_at)}</p><h3>{option?.name ?? candidate(d.candidate_id)?.name ?? "Saved option"}</h3>{changed && <p className="research-basis">Your requirements or comparison have changed. This decision’s original basis is preserved; consider revisiting it.</p>}<dl><dt>Why it fits</dt><dd>{d.rationale}</dd><dt>Accepted tradeoffs</dt><dd>{d.tradeoffs || "None recorded"}</dd><dt>Still uncertain</dt><dd>{d.uncertainties || "None recorded — not a claim of certainty"}</dd></dl><details><summary>Original brief & supporting comparison</summary><p className="research-preserved-text">{workspace.briefs.find(b => b.revision === d.requirements_revision)?.text ?? "The requirements revision was not recorded for this comparison."}</p>{basis && <Comparison value={basis.comparison} />}</details></section>;
      }) : <div className="research-empty"><p>No decision saved. Take your time comparing the evidence.</p><button className="burrow-secondary" onClick={() => setTab("compare")}>Back to comparison</button></div>}
    </section>
    {!!workspace.activity.length && <details className="research-workspace-activity"><summary>Workspace history</summary><ol>{workspace.activity.slice().reverse().map(a => <li key={a.id}><span>{a.text}</span><small>{date(a.created_at)}</small></li>)}</ol></details>}
  </div>;
}
