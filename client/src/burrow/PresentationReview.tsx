import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type BurrowTask, type ModelRouting, type PresentationCitation, type PresentationReview as Review } from "../api";
import { presentationSlides } from "./presentation";
import { taskActionError } from "./taskLanguage";
import "./project.css";

const emptySource = (): PresentationCitation => ({ claim: "", title: "", url: "", quote: "", checked: false });

export default function PresentationReview({ token, task, onDirtyChange }: { token: string; task: BurrowTask; onDirtyChange: (value: boolean) => void }) {
  const [data, setData] = useState<Review | null>(null);
  const [audience, setAudience] = useState("");
  const [sources, setSources] = useState<PresentationCitation[]>([]);
  const [checks, setChecks] = useState([false, false, false]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [routes, setRoutes] = useState<ModelRouting | null>(null);
  const [cents, setCents] = useState(10);
  const [consent, setConsent] = useState(false);
  const [undo, setUndo] = useState(false);
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const receive = useCallback((next: Review) => {
    setData(next); setAudience(next.review?.audience ?? ""); setSources((next.review?.citations ?? []).map(c => next.review?.source_version === task.version ? c : { ...c, checked: false }));
    setChecks([false, false, false]); setDirty(false); setUncertain(false); setUndo(false); setConsent(false);
  }, [task.version]);
  useEffect(() => {
    if (dirtyRef.current || pending.current) return;
    let alive = true;
    void api.presentationReview(token, task.id).then(next => { if (alive) receive(next); }).catch(() => { if (alive) setNotice("Couldn’t load the review. Refresh before deciding."); });
    return () => { alive = false; };
  }, [token, task.id, receive]);
  async function refresh() {
    if (pending.current || (dirty && !window.confirm("Discard your unsaved review edits and load the saved review?"))) return;
    pending.current = true; setBusy(true);
    try { receive(await api.presentationReview(token, task.id)); setNotice("Review refreshed. No AI request was started."); }
    catch { setNotice("Couldn’t refresh. Your edits are still here. No action was repeated."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function act(action: "save" | "approve" | "withdraw" | "evaluate" | "export") {
    if (!data || pending.current || uncertain || data.version !== task.version) return;
    pending.current = true; setBusy(true); setNotice("");
    try {
      if (action === "export") {
        const value = await api.exportPresentation(token, task.id);
        const { presentationPptx } = await import("./presentation");
        const bytes = await presentationPptx(value);
        const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
        const link = document.createElement("a"); link.href = url; link.download = "presentation.pptx"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Your PowerPoint download is ready. It is a static copy; later edits or withdrawn approval cannot recall this file.");
      } else if (action === "evaluate" && routes) {
        receive(await api.evaluatePresentation(token, task.id, task.version, data.review?.revision ?? 0, cents, routes.preview));
        setNotice("One AI review requested. Refresh to read the result; we won’t repeat it.");
      } else if (action !== "evaluate") {
        receive(await api.reviewPresentation(token, task.id, { version: task.version, revision: data.review?.revision ?? 0, action, audience, citations: sources, facts_checked: checks[0], age_checked: checks[1], school_use_approved: checks[2] }));
        setNotice(action === "approve" ? "You approved this saved version for school use." : action === "withdraw" ? "School-use approval withdrawn. Review history is preserved. Downloaded files cannot be recalled; any AI review already requested keeps its separate consent and limit." : "Sources and audience saved. School use is not approved.");
      }
    } catch (e) {
      if (action !== "export") setUncertain(true);
      setNotice(`${taskActionError(e, "Couldn’t confirm the outcome.")} Refresh to check the saved outcome. No action will repeat automatically.`);
    } finally { pending.current = false; setBusy(false); }
  }
  let exportError = "";
  try { presentationSlides(task.format, task.result); } catch { exportError = "This page contains an activity that cannot be exported faithfully. Use a text outline for PowerPoint instead."; }
  const stale = !!data && data.version !== task.version;
  const locked = busy || uncertain || !data || stale || task.state !== "draft_ready" || !!task.proposed_result;
  const approved = !!data?.approved && !stale;
  const sourceValid = (s: PresentationCitation) => {
    try { const url = new URL(s.url); return !!s.claim.trim() && !!s.title.trim() && !!s.quote.trim() && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  };
  const valid = !!audience.trim() && sources.every(sourceValid);
  const reviewRoute = routes?.preview.review;
  const subscription = reviewRoute?.connectionId.startsWith("subscription-");
  const free = !!routes && Object.values(routes.preview).every(r => r && r.inputUsdPerMillion === 0 && r.outputUsdPerMillion === 0);
  function editSource(index: number, update: Partial<PresentationCitation>) {
    setSources(current => current.map((s, i) => i === index ? { ...s, checked: false, ...update } : s)); setDirty(true); setChecks([false, false, false]);
  }
  return <details className="presentation-review" aria-label="Presentation review and download"><summary>Review &amp; download <span className="project-status">{approved ? "Approved by you" : data?.review?.status === "withdrawn" ? "Approval withdrawn" : "Needs your review"}</span></summary>
    <header><div><h3>Ready for the classroom?</h3><p>Check the facts, sources and suitability for your class. AI is optional; only you can approve school use.</p></div><button type="button" className="burrow-secondary" disabled={busy} onClick={() => void refresh()}>Refresh review</button></header>
    {notice && <p role="status" className="project-notice">{notice}</p>}
    {(stale || (data?.review && data.review.source_version !== task.version)) && <p role="status">The material changed. Earlier sign-off does not cover this version. Refresh, review the new content and check the sources again.</p>}
    {approved ? <section aria-label="Approved audience and sources"><p>Reviewed by you for <strong>{audience}</strong>.</p>{sources.map((source, i) => <section key={i} className="presentation-source" aria-label={`Source ${i + 1}`}><h4><a href={source.url} target="_blank" rel="noopener noreferrer">{i + 1}. {source.title} ↗</a></h4><p>{source.claim}</p><blockquote>{source.quote}</blockquote><p className="project-caption">Source support checked by you.</p></section>)}</section> : <fieldset disabled={locked}><legend>Audience and sources</legend>
      <label>Age or school year<input value={audience} maxLength={300} placeholder="Year 5 · ages 9–10" onChange={e => { setAudience(e.target.value); setDirty(true); setChecks([false, false, false]); }} /></label>
      <p className="project-caption">Add a source for each factual claim. Read the original and record the excerpt that supports it. Links and AI suggestions are not proof.</p>
      {sources.map((source, i) => <section key={i} className="presentation-source" aria-label={`Source ${i + 1}`}><h4>Source {i + 1}</h4>
        <label>Claim or slide<input value={source.claim} maxLength={500} onChange={e => editSource(i, { claim: e.target.value })} /></label>
        <label>Source title<input value={source.title} maxLength={300} onChange={e => editSource(i, { title: e.target.value })} /></label>
        <label>Source web address<input type="url" value={source.url} maxLength={2000} placeholder="https://…" onChange={e => editSource(i, { url: e.target.value })} /></label>
        {sourceValid(source) && <a href={source.url} target="_blank" rel="noopener noreferrer">Read source {i + 1} ↗</a>}
        <label>Supporting excerpt<textarea rows={3} value={source.quote} maxLength={2000} onChange={e => editSource(i, { quote: e.target.value })} /></label>
        <label className="project-consent"><input type="checkbox" checked={source.checked} onChange={e => editSource(i, { checked: e.target.checked })} />I read this source and checked that it supports this claim.</label>
        <button type="button" className="burrow-link" onClick={() => { setSources(sources.filter((_, n) => n !== i)); setDirty(true); setChecks([false, false, false]); }}>Remove source {i + 1}</button>
      </section>)}
      <button type="button" className="burrow-secondary" disabled={sources.length >= 24} onClick={() => { setSources([...sources, emptySource()]); setDirty(true); setChecks([false, false, false]); }}>Add source</button>
    </fieldset>}
    {!approved && <><button type="button" className="burrow-secondary" disabled={locked || !valid || !dirty} onClick={() => void act("save")}>Save review notes</button>
      <fieldset disabled={locked}><legend>Your final review</legend>{["I checked the factual claims, including any AI suggestions, against the sources.", "I checked the language, content and activities for this age group.", "I approve this saved version for school use."].map((label, i) => <label className="project-consent" key={label}><input type="checkbox" checked={checks[i]} onChange={e => setChecks(checks.map((c, n) => n === i ? e.target.checked : c))} />{label}</label>)}</fieldset>
      <button type="button" className="burrow-primary" disabled={locked || !valid || !sources.length || !sources.every(s => s.checked) || !checks.every(Boolean)} onClick={() => void act("approve")}>Approve for school use</button>
    </>}
    {approved && <div className="project-actions"><button type="button" className="burrow-primary" disabled={locked || dirty || !!exportError} onClick={() => void act("export")}>Download PowerPoint</button>{undo ? <><p>Withdraw your sign-off? The history stays saved, but downloaded copies cannot be recalled.</p><button className="burrow-secondary" disabled={locked} onClick={() => void act("withdraw")}>Confirm withdrawal</button><button className="burrow-link" onClick={() => setUndo(false)}>Keep approval</button></> : <button className="burrow-link" disabled={locked} onClick={() => setUndo(true)}>Withdraw approval</button>}</div>}
    {exportError && <p className="project-caption">{exportError}</p>}
    <p className="project-caption">PowerPoint keeps text, speaker notes and source references. Pages become static slides, not working quizzes or animations. An approval is your sign-off, not a guarantee of accuracy.</p>
    <details className="presentation-ai" onToggle={e => { if (e.currentTarget.open && !routes) void api.modelRouting(token).then(setRoutes).catch(() => setNotice("AI review is unavailable. You can still review and export without AI.")); }}><summary>Ask AI for a second opinion · optional</summary>
      <p>One model response about clarity, factual concerns and age suitability. No browsing, source verification or tools. It cannot approve school use or change your work.</p>
      {data?.evaluation ? <section aria-label="AI presentation review"><p>{data.evaluation.state === "draft_ready" ? "AI suggestions · not a fact check" : data.evaluation.state === "working" ? "Review requested. Refresh to check progress." : "Review paused or did not start. No automatic retry."}</p><p className="project-caption">Limit: {data.evaluation.max_cost_cents} US cents. Uses the material and sources saved when you requested it; later source edits are not included.</p>{data.evaluation.result && <div className="project-text">{data.evaluation.result}</div>}
        {data.evaluation.state === "working" && <button className="burrow-secondary" disabled={busy} onClick={async () => { if (pending.current) return; pending.current = true; setBusy(true); try { const evaluation = { ...task, id: data.evaluation!.id, version: data.evaluation!.version }; await api.controlBurrowAgent(token, evaluation, crypto.randomUUID(), "stop", ""); setNotice("Stop requested. Earlier charges are not undone. Refresh to confirm."); } catch { setUncertain(true); setNotice("Couldn’t confirm Stop. Refresh to check; we won’t repeat it."); } finally { pending.current = false; setBusy(false); } }}>Stop AI review</button>}
      </section> : <>
        {reviewRoute && !subscription ? <p>{reviewRoute.providerModelId} via {new URL(reviewRoute.endpoint).hostname} · {reviewRoute.fundedBy === "you" ? "funded by you" : "funded by Ohiyo"}. Input/output per million tokens: ${reviewRoute.inputUsdPerMillion}/${reviewRoute.outputUsdPerMillion}. At most {reviewRoute.maxOutputTokens.toLocaleString()} output tokens.</p> : <p>Connect a priced API or free review model. Subscription billing cannot enforce this dollar limit.</p>}
        <label>AI review limit (US cents)<input type="number" min={0} max={50} step={1} value={cents} onChange={e => { setCents(Number(e.target.value)); setConsent(false); }} /></label>
        <label className="project-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Share this saved material, audience and source excerpts with the displayed AI service for one review, within this limit. No Ohiyo chats are included.</label>
        <p className="project-caption">No request before you allow it. No retries, paid fallback or extra allowance for this version. An interrupted request may still cost money. The full context and maximum output are reserved conservatively against your limit.</p>
        <button className="burrow-secondary" disabled={locked || dirty || !data?.review || !reviewRoute || subscription || !consent || !Number.isInteger(cents) || cents < (free ? 0 : 1) || cents > 50} onClick={() => void act("evaluate")}>Allow one AI review</button>
      </>}
    </details>
    {!!data?.history?.length && <details><summary>Review history</summary>{data.history.slice().reverse().map(r => <p key={r.revision}>{r.status === "approved" ? "Approved by you" : r.status === "withdrawn" ? "Approval withdrawn" : "Review notes saved"} · saved material version {r.source_version} · {r.audience} · {r.citations.length} sources</p>)}</details>}
  </details>;
}
