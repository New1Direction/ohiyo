import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ProjectReview as Review, type ProjectProposal } from "../api";
import { apiStatus } from "../lib/apiErrors";
import "./project.css";

const labels: Record<ProjectProposal["status"], string> = { pending: "For review", approved: "Approved", rejected: "Declined", testing: "Check not confirmed", tested: "Check passed", test_failed: "Check didn’t pass", rolled_back: "Undone" };

export default function ProjectReview({ token, taskId, version, onDirtyChange }: { token: string; taskId: string; version: number; onDirtyChange: (dirty: boolean) => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [editor, setEditor] = useState<{ base: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<string | null>(null);
  const planInput = useRef<HTMLTextAreaElement>(null);
  const editing = editor !== null;
  useEffect(() => { if (editing) planInput.current?.focus(); }, [editing]);
  const pending = useRef(false);
  const reads = useRef(0);
  useLayoutEffect(() => { onDirtyChange(editor !== null); return () => onDirtyChange(false); }, [editor, onDirtyChange]);
  useEffect(() => {
    if (pending.current) return;
    const request = ++reads.current;
    let alive = true;
    void api.projectReview(token, taskId).then(next => { if (alive && request === reads.current) setReview(next); }).catch(() => { if (alive && request === reads.current) setError("Couldn’t load the project plan. Refresh review before making changes."); });
    return () => { alive = false; };
  }, [token, taskId, version]);
  useEffect(() => {
    if (!editor) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [editor]);
  async function refresh() {
    if (pending.current) return;
    reads.current++;
    pending.current = true; setBusy(true);
    try { setReview(await api.projectReview(token, taskId)); setUncertain(false); setError(""); setUndo(null); }
    catch { setError("Couldn’t refresh. Your draft is still here. No action was repeated."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function change(action: "approve" | "reject" | "test" | "rollback" | "propose", proposal?: ProjectProposal) {
    if (pending.current || uncertain) return;
    reads.current++;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (action === "propose" && editor) {
        await api.proposeProject(token, taskId, editor.base, editor.text);
        setEditor(null);
        setReview(await api.projectReview(token, taskId));
      } else if (proposal && action !== "propose") {
        setReview(await api.decideProject(token, taskId, proposal.id, action));
      }
      setUndo(null);
      setNotice(action === "propose" ? "Ready for your review. Your saved plan hasn’t changed." : action === "approve" ? proposal?.kind === "skill" ? "Permission saved. Choose Check helper when you’re ready." : "Plan saved." : action === "reject" ? "Suggestion declined. Your plan hasn’t changed." : action === "rollback" ? "Approval undone. Your previous work is preserved." : "Check finished. See the result below.");
    } catch (e) {
      setUncertain(true);
      setError(apiStatus(e) === 409 ? "This suggestion is out of date. Refresh before deciding again." : "Couldn’t confirm the outcome. Refresh to check what was saved. We won’t repeat the action automatically.");
    } finally { pending.current = false; setBusy(false); }
  }
  const locked = busy || uncertain;
  const proposals = review?.proposals.slice().reverse() ?? [];
  const needsAttention = (p: ProjectProposal) => p.status === "pending" || (p.kind === "skill" && !["rejected", "rolled_back"].includes(p.status));
  function proposalCard(p: ProjectProposal) {
    if (!review) return null;
    const stale = p.base_revision !== review.spec.revision;
    const before = review.history.find(h => h.revision === p.base_revision)?.content ?? "";
    const canUndo = p.kind === "skill" ? ["approved", "testing", "tested", "test_failed"].includes(p.status) : p.status === "approved" && review.history[review.history.length - 1]?.proposal_id === p.id;
    return <section key={p.id} className="project-proposal" aria-labelledby={`proposal-${p.id}`}>
      <header><h4 id={`proposal-${p.id}`}>{p.kind === "spec" ? "Plan change" : "Suggested helper"}</h4><span className="project-status">{p.kind === "skill" && p.status === "approved" ? "Ready to check" : labels[p.status]}</span></header>
      {p.kind === "spec" ? <><div className="project-text">{p.content}</div><details><summary>Compare with previous plan</summary><div className="project-comparison"><div><h5>Previous plan</h5><div className="project-text">{before || "No saved plan."}</div></div><div><h5>Suggested plan</h5><div className="project-text">{p.content}</div></div></div></details></> : <SkillText content={p.content} />}
      {p.kind === "skill" && <>
        {p.status === "pending" && <p className="project-caption">Written guidance only. Your approval allows a check, not use by Kikka.</p>}
        {p.status === "approved" && <p className="project-caption">Ready for a one-time format check. It won’t use AI or enable this helper.</p>}
        {p.status === "tested" && <p className="project-check-result">Format check passed. Accuracy and teaching quality still need your review. This helper is not enabled.</p>}
        {p.status === "test_failed" && <p role="status">The check failed or was unavailable. This helper is not enabled. You can undo approval; the check won’t repeat automatically.</p>}
        {p.status === "testing" && <p role="status">The check was requested, but its result isn’t confirmed. Refresh to check; we won’t run it again. You can still undo approval.</p>}
        <details><summary>About helper checks</summary><p>A one-time check of the guidance’s format, isolated from your files and the internet. It does not run the guidance with an AI model, assess its accuracy or teaching quality, or install or enable anything.</p></details>
      </>}
      {p.status === "pending" && stale && <p role="status" className="burrow-error">Out of date. Your plan has changed since this suggestion. Decline it and make a new suggestion.</p>}
      <div className="project-actions">
        {p.status === "pending" && <><button className="burrow-primary" disabled={locked || stale} onClick={() => void change("approve", p)}>{p.kind === "spec" ? "Use this plan" : "Allow a check"}</button><button className="burrow-secondary" disabled={locked} onClick={() => void change("reject", p)}>Decline</button></>}
        {p.kind === "skill" && p.status === "approved" && <button className="burrow-primary" disabled={locked} onClick={() => void change("test", p)}>Check helper</button>}
        {canUndo && (undo === p.id ? <div className="project-undo" role="group" aria-label="Confirm undo"><p>{p.kind === "spec" ? "Restore the previous plan?" : "Withdraw permission to check this helper?"} Information already shared with an AI service cannot be taken back.</p><button className="burrow-secondary" disabled={locked} onClick={() => void change("rollback", p)}>Confirm undo</button><button className="burrow-link" disabled={busy} onClick={() => setUndo(null)}>Keep approval</button></div> : <button className="burrow-link" disabled={locked} onClick={() => setUndo(p.id)}>Undo approval</button>)}
      </div>
    </section>;
  }
  return <section className="project-review" aria-label="Project plan and approvals" aria-busy={busy}>
    {error && <p role="alert" className="burrow-error">{error}</p>}
    <p className="project-notice" role="status">{busy ? "Saving or checking…" : notice}</p>
    <details className="project-plan"><summary>Project plan</summary>
    <header><div><h2>Your project plan</h2><p className="project-caption">Audience, content and style—saved for this project.</p></div><button className="burrow-secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button></header>
    {!review ? <p role="status">Loading your plan…</p> : <>
      <section className="project-saved" aria-label="Saved project plan"><header><h3>{review.spec.content ? "Saved plan" : "Start with a plan"}</h3>{!editor && <button className="burrow-secondary" disabled={locked} onClick={() => setEditor({ base: review.spec.revision, text: review.spec.content })}>{review.spec.content ? "Edit plan" : "Write a plan"}</button>}</header><div className="project-text">{review.spec.content || "Who is it for? What should it cover? Add the details you want Kikka to remember for this project."}</div>
      </section>
      {editor && <form onSubmit={e => { e.preventDefault(); void change("propose"); }}>
        <label htmlFor="project-plan-draft">Your proposed plan<textarea ref={planInput} id="project-plan-draft" rows={6} maxLength={8000} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} placeholder="Six slides about the water cycle for a year 5 class. Short sentences, speaker notes and a sources slide." /></label>
        <p className="project-caption">You’ll review this before it replaces your saved plan.</p>
        <div className="project-actions"><button className="burrow-primary" disabled={locked || !editor.text.trim() || new TextEncoder().encode(editor.text).length > 8000}>Review changes</button><button type="button" className="burrow-secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
      </form>}
      {!!review.history.length && <details className="project-history"><summary>Plan history</summary>{review.history.slice().reverse().map(h => <section key={h.revision}><h4>Version {h.revision}</h4><div className="project-text">{h.content || "Empty plan restored."}</div></section>)}</details>}
    </>}
    </details>
    {!!proposals.filter(needsAttention).length && <section aria-label="Suggestions"><h3>For your review</h3>{proposals.filter(needsAttention).map(proposalCard)}</section>}
    {!!proposals.filter(p => !needsAttention(p)).length && <details className="project-history"><summary>Previous decisions</summary>{proposals.filter(p => !needsAttention(p)).map(proposalCard)}</details>}
  </section>;
}

function SkillText({ content }: { content: string }) {
  try {
    const skill = JSON.parse(content) as { name: string; description: string; instructions: string };
    return <div className="project-helper"><h5>{skill.name}</h5><p>{skill.description}</p><details><summary>Read the guidance</summary><div className="project-text">{skill.instructions}</div></details></div>;
  } catch { return <p>This helper’s guidance couldn’t be displayed. Decline it and request a new suggestion.</p>; }
}
