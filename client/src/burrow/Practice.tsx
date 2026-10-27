import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type BurrowTask, type ModelRouting, type PracticeContent, type PracticeView } from "../api";
import { Quiz } from "./GeneratedPage";
import { taskActionError } from "./taskLanguage";
import "./creation.css";
import "./project.css";

function usableContent(content: PracticeContent | null): content is PracticeContent {
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  return !!content && text(content.objective) && text(content.explanation?.text) && text(content.explanation?.quote)
    && text(content.worked_example?.text) && text(content.worked_example?.quote)
    && Array.isArray(content.questions) && content.questions.length === 3
    && content.questions.every(q => q && text(q.question) && text(q.explanation) && text(q.quote)
      && Array.isArray(q.options) && q.options.length >= 2 && q.options.every(text)
      && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
}

export default function Practice({ token, task, onDirtyChange }: { token: string; task: BurrowTask; onDirtyChange: (value: boolean) => void }) {
  const [opened, setOpened] = useState(false);
  const [data, setData] = useState<PracticeView | null>(null);
  const [routes, setRoutes] = useState<ModelRouting | null>(null);
  const [objective, setObjective] = useState("");
  const [audience, setAudience] = useState("");
  const [cents, setCents] = useState(10);
  const [consent, setConsent] = useState(false);
  const [checks, setChecks] = useState([false, false]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [withdraw, setWithdraw] = useState(false);
  const eligible = task.format === "document" && task.kind === "writing" && !task.coding
    && !task.comparison && !task.travel && !task.template
    && task.state === "draft_ready" && !!task.result.trim() && !task.proposed_result;
  useLayoutEffect(() => { onDirtyChange(dirty || busy || uncertain); return () => onDirtyChange(false); }, [dirty, busy, uncertain, onDirtyChange]);
  const receive = useCallback((next: PracticeView) => {
    setData(next); setObjective(""); setAudience(""); setConsent(false); setChecks([false, false]);
    setDirty(false); setUncertain(false); setWithdraw(false);
  }, []);
  useEffect(() => {
    if (!opened || !eligible || dirtyRef.current || pending.current) return;
    let alive = true;
    void api.practice(token, task.id).then(next => { if (alive) receive(next); })
      .catch(() => { if (alive) setNotice("Couldn’t load practice. Refresh to check. No AI request was started."); });
    return () => { alive = false; };
  }, [opened, eligible, token, task.id, task.version, receive]);
  useEffect(() => {
    if (!opened || !eligible) return;
    let alive = true;
    void api.modelRouting(token).then(next => { if (alive) setRoutes(next); })
      .catch(() => { if (alive) setNotice("Couldn’t load the model choices. You can still refresh and read saved practice."); });
    return () => { alive = false; };
  }, [opened, eligible, token]);
  const pack = data?.pack;
  const stale = !!data && (data.source_version !== task.version || !!pack && (pack.stale || pack.source_version !== task.version));
  const currentPack = !!pack && pack.source_version === task.version;
  const locked = busy || uncertain || !data || data.source_version !== task.version || !eligible;
  const content = pack?.content && usableContent(pack.content) ? pack.content : null;
  const approved = pack?.status === "approved" && pack.state === "draft_ready" && !stale && !!content;
  const canGenerate = !locked && !currentPack;
  const route = routes?.preview.general;
  const priced = !!route && !route.connectionId.startsWith("subscription-")
    && typeof route.inputUsdPerMillion === "number" && Number.isFinite(route.inputUsdPerMillion) && route.inputUsdPerMillion >= 0
    && typeof route.outputUsdPerMillion === "number" && Number.isFinite(route.outputUsdPerMillion) && route.outputUsdPerMillion >= 0;
  let host = "";
  try { if (route) { const url = new URL(route.endpoint); if (["https:", "http:"].includes(url.protocol)) host = url.hostname; } } catch { /* No undisclosed service may receive consent. */ }
  const generationReady = canGenerate && priced && !!host && consent && !!objective.trim() && !!audience.trim()
    && Number.isInteger(cents) && cents >= 0 && cents <= 50;
  function edit() { setDirty(true); setConsent(false); }
  async function refresh() {
    if (pending.current || (dirty && !window.confirm("Discard your unsaved practice choices and load saved practice?"))) return;
    pending.current = true; setBusy(true);
    try {
      const [next, routing] = await Promise.all([api.practice(token, task.id), api.modelRouting(token).catch(() => null)]);
      receive(next); setRoutes(routing); setNotice("Practice refreshed. No AI request was started.");
    }
    catch { setNotice("Couldn’t refresh practice. Your choices are still here. No action was repeated."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function act(action: "generate" | "approve" | "withdraw" | "stop") {
    if (pending.current || locked) return;
    if (action === "generate" && (!generationReady || !routes)) return;
    if (action !== "generate" && (!pack || (stale && action !== "stop"))) return;
    if (action === "approve" && (!content || pack?.state !== "draft_ready" || !checks.every(Boolean))) return;
    if (action === "withdraw" && !withdraw) return;
    pending.current = true; setBusy(true); setNotice("");
    try {
      if (action === "generate" && routes) {
        receive(await api.generatePractice(token, task.id, { version: task.version, objective, audience, allow_practice: true, max_cost_cents: cents, routing: routes.preview }));
        setNotice("One practice generation requested. Refresh to check progress. No automatic retry.");
      } else if (action === "stop" && pack) {
        await api.controlBurrowAgent(token, { ...task, id: pack.id, version: pack.version }, crypto.randomUUID(), "stop", "");
        // A read confirms the latest state; it never repeats generation or Stop.
        receive(await api.practice(token, task.id));
        setNotice("Stop requested. Earlier charges are not undone. Refresh to confirm progress if it is still working.");
      } else if (pack && (action === "approve" || action === "withdraw")) {
        receive(await api.reviewPractice(token, task.id, { version: task.version, pack_id: pack.id, pack_version: pack.version, revision: pack.revision, action, answers_checked: checks[0], age_checked: checks[1] }));
        setNotice(action === "approve" ? "You approved this exact practice pack. School-use approval of the material is separate." : "Practice approval withdrawn. School-use approval of the material is unchanged.");
      }
    } catch (error) {
      setUncertain(true); setConsent(false); setChecks([false, false]);
      setNotice(`${taskActionError(error, "Couldn’t confirm the outcome.")} Refresh practice to check the saved outcome. No action will repeat automatically.`);
    } finally { pending.current = false; setBusy(false); }
  }
  return <details className="presentation-review practice-review" aria-label="Practice from saved material" onToggle={e => { if (e.currentTarget === e.target && e.currentTarget.open) setOpened(true); }}>
    <summary>Practise from this material</summary>
    {!eligible ? <p>Practice needs a complete, saved text document with no proposed changes. Save or resolve material edits first.</p> : opened && <>
      <header><div><h3>Private practice from your saved text</h3><p>One objective, a worked example and three questions. You review the exact answers before practising. This approval is separate from school use of the material.</p></div><button type="button" className="burrow-secondary" disabled={busy} onClick={() => void refresh()}>Refresh practice</button></header>
      {notice && <p className="project-notice" role="status">{notice}</p>}
      {stale && <p role="status">The material changed. This earlier pack is read-only; its approval does not cover the current saved version, even if the same text was restored.</p>}
      {pack && <section aria-label="Saved practice pack">
        <p><strong>{pack.objective}</strong> · {pack.audience}</p>
        <p className="project-caption">Saved material version {pack.source_version} · Limit: {pack.max_cost_cents} US cents · {pack.status === "approved" ? "Approved by you for private practice" : pack.status === "withdrawn" ? "Practice approval withdrawn" : "Needs your answer and age review"}</p>
        {pack.state === "working" || pack.state === "waiting" ? <><p>Practice requested. Refresh to check progress; we won’t repeat the request.</p><button type="button" className="burrow-secondary" disabled={locked} onClick={() => void act("stop")}>Stop practice generation</button></> : pack.state !== "draft_ready" && <p>Practice paused or did not finish. No automatic retry and no extra generation allowance for this saved version.</p>}
        {pack.error && <p role="status">{pack.error}</p>}
        {pack.content && !content && <p role="alert">This pack cannot be displayed safely. It cannot be approved or practised.</p>}
        {content && (approved ? <section aria-label="Approved private practice">
          <h4>{content.objective}</h4>
          <p className="project-caption">Answers and scores stay temporarily in this view. They are not saved and do not establish mastery. Try the questions before revealing the explanation.</p>
          <details className="gen-reveal"><summary>Reveal explanation</summary><p className="project-text">{content.explanation.text}</p><blockquote>{content.explanation.quote}</blockquote></details>
          <details className="gen-reveal"><summary>Reveal worked example</summary><p className="project-text">{content.worked_example.text}</p><blockquote>{content.worked_example.quote}</blockquote></details>
          <fieldset disabled={locked}><Quiz key={`${pack.id}:${pack.version}:${pack.revision}:${task.version}`} questions={content.questions.map(q => ({ ...q, explanation: `${q.explanation}\n\nFrom saved material version ${pack.source_version}: “${q.quote}”` }))} /></fieldset>
        </section> : <section aria-label="Practice answer review">
          <h4>{content.objective}</h4><h4>Explanation</h4><p className="project-text">{content.explanation.text}</p><blockquote>{content.explanation.quote}</blockquote>
          <h4>Worked example</h4><p className="project-text">{content.worked_example.text}</p><blockquote>{content.worked_example.quote}</blockquote>
          {content.questions.map((q, i) => <section className="presentation-source" key={i}><h4>{i + 1}. {q.question}</h4><ol type="A">{q.options.map((option, n) => <li key={n}>{option}</li>)}</ol><p><strong>Answer: {String.fromCharCode(65 + q.answer)}. {q.options[q.answer]}</strong></p><p>{q.explanation}</p><blockquote>{q.quote}</blockquote></section>)}
          <p className="project-caption">Excerpts are from saved material version {pack.source_version}. Matching a quote is not an independent fact check. Check every answer for accuracy and ambiguity.</p>
        </section>)}
        {content && !stale && pack.state === "draft_ready" && pack.status !== "approved" && <>
          <fieldset disabled={locked}><legend>Your practice review</legend>{["I checked all three answers, explanations and supporting quotes against the saved material.", "I checked the language and activities for this learner’s age and level."].map((label, i) => <label key={label} className="project-consent"><input type="checkbox" checked={checks[i]} onChange={e => { setChecks(checks.map((c, n) => n === i ? e.target.checked : c)); setDirty(true); }} />{label}</label>)}</fieldset>
          <button type="button" className="burrow-primary" disabled={locked || !checks.every(Boolean)} onClick={() => void act("approve")}>Approve private practice</button>
        </>}
        {pack.status === "approved" && !stale && (withdraw ? <div className="project-actions"><p>Withdraw approval for this practice pack? It will no longer be available to practise.</p><button type="button" className="burrow-secondary" disabled={locked} onClick={() => void act("withdraw")}>Confirm practice withdrawal</button><button type="button" className="burrow-link" disabled={busy} onClick={() => setWithdraw(false)}>Keep practice approval</button></div> : <button type="button" className="burrow-link" disabled={locked} onClick={() => setWithdraw(true)}>Withdraw practice approval</button>)}
        {!!pack.history?.length && <details><summary>Practice approval history</summary>{pack.history.slice().reverse().map(entry => <p key={entry.revision}>{entry.status === "approved" ? "Approved by you for private practice" : "Practice approval withdrawn"} · decision {entry.revision} · output version {entry.output_version}</p>)}</details>}
      </section>}
      {(!pack || !currentPack) && <fieldset disabled={locked}><legend>Choose one learning objective</legend>
        <label>Learning objective<textarea rows={2} maxLength={300} value={objective} placeholder="Explain why water forms droplets on a cold surface" onChange={e => { setObjective(e.target.value); edit(); }} /></label>
        <label>Learner age or school year<input maxLength={300} value={audience} placeholder="Year 5 · ages 9–10" onChange={e => { setAudience(e.target.value); edit(); }} /></label>
        {priced && host && route ? <p>{route.providerModelId} via {host} · {route.fundedBy === "you" ? "funded by you" : "funded by Ohiyo"}. Input/output per million tokens: ${route.inputUsdPerMillion}/${route.outputUsdPerMillion}. At most {route.maxOutputTokens.toLocaleString()} output tokens.</p> : <p>Connect a priced API or free general model. Subscription billing cannot enforce this dollar limit.</p>}
        <label>Practice generation limit (US cents)<input type="number" min={0} max={50} step={1} value={Number.isNaN(cents) ? "" : cents} onChange={e => { setCents(e.target.value === "" ? NaN : Number(e.target.value)); edit(); }} /></label>
        <label className="project-consent"><input type="checkbox" disabled={!priced || !host} checked={consent} onChange={e => { setConsent(e.target.checked); setDirty(true); }} />Share only this selected document’s saved text, objective and learner age with the displayed AI service for one practice generation within this limit. No Ohiyo chats, project context or separate review sources are included.</label>
        <p className="project-caption">School-source notes in Review &amp; download stay separate. Practice uses those notes only if they are part of this saved document.</p>
        <p className="project-caption">One no-tool AI response. No browsing, automatic generation, retries, paid fallback or subscription route. One generation allowance per saved material version, separate from AI review. Interrupted requests may still cost money; the full context and maximum output are reserved against the limit.</p>
        <button type="button" className="burrow-primary" disabled={!generationReady} onClick={() => void act("generate")}>Allow one practice generation</button>
      </fieldset>}
    </>}
  </details>;
}
