import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { api, type BurrowContext, type BurrowMemory, type BurrowTask } from "../api";
import { taskActionError } from "./taskLanguage";

export type MemoryDraft = { prepare: (text: string) => void };
export default function TaskContext({ task, token, onUpdate, onDirtyChange, ref }: { task: BurrowTask; token: string; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void; ref?: Ref<MemoryDraft> }) {
  const [data, setData] = useState<BurrowContext | null>(null);
  const [text, setText] = useState("");
  const [personal, setPersonal] = useState(false);
  const [edit, setEdit] = useState<BurrowMemory | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("My supplier comparison");
  const [method, setMethod] = useState("Compare the supplied pages against current project requirements. Include materials, minimum order quantities, prices, delivery eligibility and unknowns. Collect fresh evidence.");
  const [routine, setRoutine] = useState("");
  const [inputs, setInputs] = useState("");
  const [notes, setNotes] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const memoryDetails = useRef<HTMLDetailsElement>(null);
  useImperativeHandle(ref, () => ({ prepare(selected: string) {
    if (busy || edit || text.trim()) setError("Your saved-choice draft is still here. Save or cancel it before remembering another selection.");
    else { setText(selected); setPersonal(false); setError(""); setNotice("Review this selection and its scope before saving. Nothing has been remembered yet."); }
    if (memoryDetails.current) memoryDetails.current.open = true;
    requestAnimationFrame(() => { const input = memoryDetails.current?.querySelector("textarea"); input?.scrollIntoView({ block: "center" }); input?.focus({ preventScroll: true }); });
  } }), [busy, edit, text]);
  const dirty = (edit ? text !== edit.text : !!text.trim()) || (notes !== null && notes !== (task.manual_notes ?? ""));
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const savedRoutine = data?.routines.find(r => r[0] === task.routine_id || r[4] === task.id);
  async function refresh(q = query) { setData(await api.burrowContext(token, task.id, q)); }
  useEffect(() => { let alive = true; void api.burrowContext(token, task.id).then(d => { if (alive) { setData(d); const saved = d.routines.find(r => r[0] === task.routine_id || r[4] === task.id); if (saved) { setName(saved[2]); setMethod(JSON.parse(saved[3]).instructions); } } }).catch(() => { if (alive) setError("Couldn’t load your saved choices. Nothing was changed."); }); return () => { alive = false; }; }, [token, task.id, task.routine_id]);
  async function act(fn: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await refresh(); setNotice(message); }
    catch (e) { setError(taskActionError(e, "Couldn’t confirm the change. Your text is still here; refresh before trying again.")); }
    finally { setBusy(false); }
  }
  return <section className="burrow-context burrow-request-details">
    <h2>Saved choices</h2><p className="burrow-small">{task.project ? `Project: ${task.project}` : "No project requirements"}. Personal preferences are labeled separately. These never authorize actions or spending.</p>
    {data?.memories.map(m => <div className="burrow-memory-row" key={m.id}><p>{m.text}</p><small>{m.project ? `Project: ${m.project}` : "Personal preference"} · Updated {new Date(m.updated_at * 1000).toLocaleString()} · Version {m.version} · <a href={`/burrow?task=${encodeURIComponent(m.source_task)}`}>Original task</a></small><div><button className="burrow-link" disabled={busy} onClick={() => { setEdit(m); setText(m.text); setPersonal(!m.project); if (memoryDetails.current) memoryDetails.current.open = true; requestAnimationFrame(() => memoryDetails.current?.querySelector("textarea")?.focus()); }}>Edit</button><button className="burrow-link" disabled={busy} onClick={() => { if (window.confirm("Forget this saved choice? Kikka won’t save it again automatically. The original task history stays saved; deleting history is a separate action.")) void act(() => api.changeBurrowMemory(token, m, null), "Forgotten. Original history was not deleted."); }}>Forget</button></div></div>)}
    {data?.memories.length === 0 && <p className="burrow-small">No saved choices yet. Remember a requirement below.</p>}
    <details ref={memoryDetails}><summary>From our previous work{task.project ? ` · ${task.project}` : " · Personal"}{data ? ` (${data.memories.length})` : ""}</summary>
      <p className="burrow-small">Kikka remembers requirements you choose to save here. Changes apply to your next instruction. Saved choices never give permission to act or spend.</p>
      <p className="burrow-small">Review the wording and scope below. Nothing is saved until you choose Remember this.</p>
      <form onSubmit={e => { e.preventDefault(); void act(async () => { if (edit) await api.changeBurrowMemory(token, edit, text); else await api.rememberBurrow(token, task.id, text.replace(/^Remember for this project:\s*/i, ""), personal); setText(""); setEdit(null); }, "Saved. Kikka will use the current requirement on the next instruction."); }}>
        <label>{edit ? "Edit saved choice" : "Remember this"}<textarea rows={2} maxLength={1200} value={text} onChange={e => setText(e.target.value)} placeholder="A requirement to remember for this project…" required /></label>
        {!edit && <label><input type="checkbox" checked={personal} onChange={e => setPersonal(e.target.checked)} /> Personal preference (all projects)</label>}
        {!task.project && !personal && <p className="burrow-small">This task has no project. Create a task with a project name to save project requirements.</p>}
        <button className="burrow-secondary" disabled={busy || !text.trim() || (!edit && !task.project && !personal)}>{edit ? "Save correction" : "Remember this"}</button>{(edit || text) && <button type="button" className="burrow-link" disabled={busy} onClick={() => { setEdit(null); setText(""); setPersonal(false); setError(""); setNotice(""); }}>Cancel</button>}
      </form>
      <form onSubmit={e => { e.preventDefault(); void act(() => refresh(), "Search complete. Open the original task for full details."); }}><label>Search previous work<input maxLength={200} value={query} onChange={e => setQuery(e.target.value)} placeholder="Supplier, decision, price…" /></label><button className="burrow-secondary" disabled={busy}>Search</button></form>
      {data?.history.map(([id, title, excerpt, time]) => <details key={id}><summary>{title}</summary><p className="burrow-small">A short excerpt—open the original for full details · {new Date(time * 1000).toLocaleString()}</p><p className="burrow-document">{excerpt || "No saved result yet."}</p><a href={`/burrow?task=${encodeURIComponent(id)}`}>Open original task and versions ↗</a></details>)}
    </details>
    {task.comparison && <details><summary>Do this again{task.routine_id ? ` · version ${task.routine_version}` : ""}</summary>
      <p className="burrow-small">Save how Kikka compares, not the old answers. Each new task gathers fresh information and needs your approval before starting. This does not schedule automatic checks.</p>
      {task.state === "draft_ready" && <form onSubmit={e => { e.preventDefault(); void act(() => api.saveBurrowRoutine(token, task.id, name, method), "Routine saved."); }}><label>Routine name<input value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label><label>How to compare<textarea value={method} maxLength={2000} onChange={e => setMethod(e.target.value)} required rows={3} /></label><button className="burrow-secondary" disabled={busy}>{savedRoutine ? "Change routine" : "Save routine"}</button></form>}
      {!!data?.routines.length && <form onSubmit={e => { e.preventDefault(); void act(async () => { const next = await api.createBurrowTask(token, inputs, "writing", undefined, { project: task.project ?? undefined, routine_id: routine, comparison: true }); onUpdate(next); window.location.assign(`/burrow?task=${encodeURIComponent(next.id)}`); }, "New request saved. Review and approve before starting."); }}><label>Saved routine<select value={routine} onChange={e => setRoutine(e.target.value)}><option value="">Choose a routine</option>{data.routines.map(([id, version, title]) => <option key={id} value={id}>{title} · v{version}</option>)}</select></label><label>New request and approved pages<textarea rows={3} value={inputs} maxLength={8000} onChange={e => setInputs(e.target.value)} required placeholder="Use my supplier comparison on these pages: https://…" /></label><button className="burrow-secondary" disabled={busy || !routine || !inputs.trim()}>Use again</button></form>}
    </details>}
    <details><summary>Your notes{task.manual_notes ? " · saved" : ""}</summary><p className="burrow-small">Your manual additions stay attached to this result and cannot be overwritten by Kikka’s revisions.</p><label>Edit notes<textarea rows={3} maxLength={8000} value={notes ?? task.manual_notes ?? ""} onChange={e => setNotes(e.target.value)} /></label><button className="burrow-secondary" disabled={busy || notes === null} onClick={() => void act(async () => { onUpdate(await api.saveBurrowNotes(token, task, notes!)); setNotes(null); }, "Notes saved.")}>Save notes</button></details>
    {notice && <p className="burrow-small" role="status">{notice}</p>}{error && <p className="burrow-error" role="alert">{error}</p>}
  </section>;
}
