import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, getApiBase, type BurrowAgent, type BurrowTask, type ModelRole, type ModelRouting } from "../api";
import { apiStatus } from "../lib/apiErrors";
import KikkaReply from "./KikkaReply";
import { modelRoles, RouteDisclosure } from "./ModelSettings";
import TaskContext, { type MemoryDraft } from "./TaskContext";
import SelectionActions from "./SelectionActions";
import Comparison from "./ResearchComparison";
import PrivateBrowser from "./PrivateBrowser";
import { SavedTravelText as SavedResearchText, TravelProgress, parseTravelResult } from "./Travel";
import { followUpLabel, taskActionError, taskActivity } from "./taskLanguage";
import { submitPromptOnEnter } from "./promptKeys";
import "./research.css";

type Tab = "result" | "sources" | "activity";
type Place = { run: string; seq: number; tab: Tab; pane: "conversation" | "result"; conversation: number; result: number };

// Tab-local navigation metadata only: never store prompts, results or raw tokens.
function useReadingPlace(token: string, task: string) {
  const key = useRef<string | null>(null);
  const [saved, setSaved] = useState<Place | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${getApiBase()}:${token}`));
        const scope = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
        const nextKey = `burrow:place:${scope}:${task}`;
        const raw: unknown = JSON.parse(sessionStorage.getItem(nextKey) ?? "null");
        const p = raw as Place | null;
        const valid = p && typeof p.run === "string" && Number.isSafeInteger(p.seq) && p.seq >= 0
          && ["result", "sources", "activity"].includes(p.tab)
          && ["conversation", "result"].includes(p.pane)
          && [p.conversation, p.result].every(n => Number.isFinite(n) && n >= 0 && n <= 10_000_000);
        if (alive) { key.current = nextKey; setSaved(valid ? p : null); }
      } catch { if (alive) setSaved(null); }
    })();
    return () => { alive = false; key.current = null; };
  }, [token, task]);
  const remember = useCallback((place: Place) => {
    try { if (key.current) sessionStorage.setItem(key.current, JSON.stringify(place)); } catch { /* Reading must work without storage. */ }
  }, []);
  return { saved, remember };
}

function RevisionDiff({ before, after }: { before: string; after: string }) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  let first = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  while (first < oldEnd && first < newEnd && oldLines[first] === newLines[first]) first++;
  while (oldEnd > first && newEnd > first && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const previous = oldLines.slice(first, oldEnd), next = newLines.slice(first, newEnd);
  return <div className="research-diff"><p className="burrow-small">The saved wording, side by side. Unchanged text at the beginning and end is hidden.</p>{previous.length || next.length ? <><section><h3>Before</h3><pre><del>{previous.slice(0, 24).join("\n") || "No removed text."}</del></pre></section><section><h3>Now</h3><pre><ins>{next.slice(0, 24).join("\n") || "No added text."}</ins></pre></section>{(previous.length > 24 || next.length > 24) && <p className="burrow-small">Showing the first 24 changed lines per version. Full text remains in the result and Previous versions.</p>}</> : <p>No text changes.</p>}</div>;
}

export default function ResearchTask({ task, token, canRun, onUpdate, onDirtyChange }: { task: BurrowTask; token: string; canRun: boolean; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void }) {
  const selectionRoot = useRef<HTMLElement>(null);
  const memoryDraft = useRef<MemoryDraft>(null);
  const [view, setView] = useState<BurrowAgent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const instructionInput = useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useRef<HTMLDetailsElement>(null);
  const [editor, setEditor] = useState<{ text: string; version: number } | null>(null);
  const [contextDirty, setContextDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("result");
  const [mobilePane, setMobilePane] = useState<"conversation" | "result">("conversation");
  const [review, setReview] = useState<{ before?: string; after: string; version: number } | null>(null);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const conversationPane = useRef<HTMLDivElement>(null);
  const resultPane = useRef<HTMLDivElement>(null);
  const changes = useRef<HTMLElement>(null);
  const context = useRef<HTMLDivElement>(null);
  const place = useReadingPlace(token, task.id);
  const latestSeq = view?.events.slice().reverse().find(e => e.type === "final_message")?.seq ?? 0;
  const returning = place.saved && place.saved.run === view?.agent.id ? place.saved : null;
  useEffect(() => { if (place.saved !== undefined && view && seenSeq === null) setSeenSeq(returning?.seq ?? latestSeq); }, [place.saved, view, seenSeq, returning?.seq, latestSeq]);
  const runId = view?.agent.id;
  const savePlace = place.remember;
  const returnSeq = returning?.seq;
  useEffect(() => {
    if (runId && seenSeq !== null && seenSeq !== returnSeq) savePlace({ run: runId, seq: seenSeq, tab: "result", pane: "conversation", conversation: conversationPane.current?.scrollTop ?? 0, result: resultPane.current?.scrollTop ?? 0 });
  }, [runId, seenSeq, returnSeq, savePlace]);
  const dirty = contextDirty || !!instruction.trim() || (!!editor && editor.text !== task.result);
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [cents, setCents] = useState(25);
  const [routing, setRouting] = useState<ModelRouting | null>(null);
  const [routingLoaded, setRoutingLoaded] = useState(false);
  const [role, setRole] = useState<ModelRole>("research");
  const zeroPrice = !!routing?.catalog.length && modelRoles.every(r => routing.preview[r]?.inputUsdPerMillion === 0 && routing.preview[r]?.outputUsdPerMillion === 0);
  useEffect(() => { setCents(current => zeroPrice ? 0 : current === 0 ? 25 : current); }, [zeroPrice]);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      try { const next = await api.modelRouting(token); if (alive) { setRouting(next); setRoutingLoaded(true); } }
      catch { if (alive) { setRoutingLoaded(true); setRouting(null); } }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [token]);
  const [image, setImage] = useState<{ src: string; url?: string; capturedAt?: string } | null>(null);
  const pending = useRef<{ id: string; action: "steer" | "stop" | "continue"; message: string } | null>(null);
  const pendingStop = useRef<{ id: string; action: "steer" | "stop" | "continue"; message: string } | null>(null);
  const update = useRef(onUpdate); update.current = onUpdate;
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const next = await api.burrowAgent(token, task.id); if (alive) { setView(next); setLoaded(true); update.current(next.task); } }
      catch (e) { if (alive) { if (apiStatus(e) === 404) setLoaded(true); else setError("Couldn’t refresh this task. Its displayed activity may be out of date."); } }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [token, task.id]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.src); }, [image]);
  const stopped = task.state === "failed" && !!task.error?.startsWith("Stopped");
  const stopping = !stopped && view?.commands.some(c => c[1] === "stop" && ["queued", "dispatching", "sent"].includes(c[3])) && !["finished", "review"].includes(view.agent.phase);
  const status = stopping ? "Stopping" : stopped ? "Stopped" : task.state === "working" ? "Working" : task.state === "draft_ready" ? "Ready" : "Needs you";
  const active = !!view && view.agent.phase !== "finished" && task.state !== "draft_ready" && !stopped;
  const instructionAllowed = !!view && view.connected && view.agent.phase !== "review" && !stopping && !stopped && (task.state === "working" || task.state === "draft_ready");
  async function start() {
    setBusy(true); setError(""); setNotice("");
    try { await api.startBurrowAgent(token, task, cents, routing?.catalog.length ? role : undefined, routing?.catalog.length ? routing.preview : undefined); const next = await api.burrowAgent(token, task.id); setView(next); onUpdate(next.task); }
    catch (e) { setError(taskActionError(e, "Couldn’t confirm whether work started. Reopen the task before trying again.")); }
    finally { setBusy(false); }
  }
  async function control(action: "steer" | "stop" | "continue") {
    // An uncertain instruction must not prevent the owner from requesting Stop.
    const queue = action === "stop" ? pendingStop : pending;
    if (queue.current && (queue.current.action !== action || queue.current.message !== (action === "stop" ? "" : instruction))) {
      setError("Kikka hasn’t confirmed your previous instruction. Reopen this task before sending a different one. You can still choose Stop."); return;
    }
    queue.current ??= { id: crypto.randomUUID(), action, message: action === "stop" ? "" : instruction };
    setBusy(true); setError(""); setNotice("");
    try {
      const p = queue.current;
      onUpdate(await api.controlBurrowAgent(token, task, p.id, p.action, p.message));
      queue.current = null;
      if (action === "stop") pending.current = null; else setInstruction("");
      const next = await api.burrowAgent(token, task.id); setView(next); onUpdate(next.task);
    } catch (e) { setError(taskActionError(e, action === "stop" ? "Couldn’t confirm that Stop arrived. Trying Stop again checks the same request. Kikka is not confirmed stopped yet." : "Couldn’t confirm that your instruction arrived. Trying again checks the same request rather than sending a new one.")); }
    finally { setBusy(false); }
  }
  async function showEvidence(id: string) {
    setError("");
    try {
      const source = view?.events.find(e => e.type === "evidence" && e.data.id === id)?.data;
      setImage({ src: URL.createObjectURL(await api.burrowEvidence(token, task.id, id)), url: source?.url, capturedAt: source?.capturedAt });
    }
    catch (e) { setError(taskActionError(e, "Couldn’t open this saved screenshot. Try again in a moment.")); }
  }
  const evidence = [...new Map(view?.events.filter(e => e.type === "evidence" && e.data.id).map(e => [e.data.id, e.data]) ?? []).values()];
  const comparison = !task.manual_edited && !parseTravelResult(task.result) ? view?.events.slice().reverse().find(e => e.type === "final_message" && e.data.content === task.result)?.data.comparison : undefined;
  const hasNewResult = seenSeq !== null && latestSeq > seenSeq;
  const seenText = view?.events.find(e => e.type === "final_message" && e.seq === seenSeq)?.data.content;
  const baseline = task.proposed_result ? task.result : seenText && seenText !== task.result ? seenText : view?.history.find(([, text]) => text !== task.result)?.[1];
  const budget = view?.agent.max_cost_cents;
  const planRoutes = view?.agent.routing ?? routing?.preview;
  const subscriptionOnly = modelRoles.every(r => planRoutes?.[r]?.connectionId.startsWith("subscription-"));
  const activity = stopping ? "Stop requested. Waiting for Kikka to confirm; work may still be running." : taskActivity(task, view);
  const failure = task.error && !stopped ? taskActivity(task, view) : "";
  const lastInstruction = view?.commands.filter(c => c[1] !== "stop").slice(-1)[0];
  function insertEmoji(emoji: string) {
    const input = instructionInput.current;
    if (!input || busy) return;
    const start = input.selectionStart, end = input.selectionEnd;
    const next = instruction.slice(0, start) + emoji + instruction.slice(end);
    if (next.length > 8000) { setError("This message is full. Remove some text before adding an emoji."); return; }
    setInstruction(next);
    if (emojiPicker.current) emojiPicker.current.open = false;
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + emoji.length, start + emoji.length); });
  }
  function remember(nextTab = tab, seq = seenSeq, pane = mobilePane) {
    if (view && seq !== null) place.remember({ run: view.agent.id, seq, tab: nextTab, pane, conversation: conversationPane.current?.scrollTop ?? 0, result: resultPane.current?.scrollTop ?? 0 });
  }
  function openTab(next: Tab) { setTab(next); setMobilePane("result"); remember(next, seenSeq, "result"); }
  function showChanges() {
    setReview({ before: baseline, after: task.proposed_result || task.result, version: task.version });
    setSeenSeq(latestSeq); openTab("result"); remember("result", latestSeq, "result");
    requestAnimationFrame(() => { changes.current?.scrollIntoView({ block: "nearest" }); changes.current?.focus(); });
  }
  function pickUp() {
    if (hasNewResult || task.proposed_result) { showChanges(); return; }
    if (!returning) return;
    setTab(returning.tab); setMobilePane(returning.pane);
    requestAnimationFrame(() => {
      if (conversationPane.current) conversationPane.current.scrollTop = returning.conversation;
      if (resultPane.current) resultPane.current.scrollTop = returning.result;
      (returning.pane === "conversation" ? conversationPane : resultPane).current?.focus({ preventScroll: true });
    });
  }
  async function decide(accept: boolean) {
    if (busy || editor || !review || review.version !== task.version) return;
    if (accept && !window.confirm("Replace the current result with this revision? Your edited version stays in Previous versions.")) return;
    setBusy(true); setError("");
    try { onUpdate(await (accept ? api.acceptBurrowRevision(token, task) : api.keepBurrowResult(token, task))); setReview(null); setNotice(accept ? "Revision saved. Your previous version is preserved." : "Kept your edited result. No work was started."); }
    catch (e) { setError(taskActionError(e, "Couldn’t confirm your choice. Refresh before trying again.")); }
    finally { setBusy(false); }
  }
  return <article ref={selectionRoot} className={`research-studio pane-${mobilePane}`}>
    <SelectionActions root={selectionRoot} onRemember={selected => { openTab("result"); memoryDraft.current?.prepare(selected); }} onQuote={instructionAllowed && !busy ? selected => {
      const quote = selected.split("\n").map(line => `> ${line}`).join("\n");
      const next = `${instruction}${instruction ? "\n\n" : ""}${quote}\n\n`;
      if (next.length > 8000) { setError("There isn’t enough room for this quote. Shorten your selection or your draft; nothing was replaced."); return; }
      setInstruction(next); setMobilePane("conversation");
      requestAnimationFrame(() => { instructionInput.current?.focus(); instructionInput.current?.setSelectionRange(next.length, next.length); });
    } : undefined} />
    <header className="research-toolbar"><div><p className="burrow-small">{task.project ?? "Your research"}</p><h1>{task.request.length > 100 ? `${task.request.slice(0, 100)}…` : task.request}</h1></div><span className={`burrow-status ${task.state}`} role="status">{status}</span><button className="burrow-secondary" disabled={!active || busy || stopping || !view?.connected || view?.agent.phase === "review"} onClick={() => void control("stop")}>{stopping ? "Stopping…" : "Stop"}</button></header>
    <div className="research-controls"><details><summary>Brief</summary><p>{task.request}</p></details><details><summary>Scope</summary><p>Kikka can only read the public pages allowed for this task. No signing in, contacting suppliers, purchases or account changes. Saved choices do not give permission to take action.</p></details><button className="burrow-link" onClick={() => { openTab("result"); requestAnimationFrame(() => { context.current?.scrollIntoView({ block: "start" }); context.current?.focus(); }); }}>Saved choices</button><span className="research-budget">{subscriptionOnly ? "Your plan · Up to 20 requests for this task" : budget == null ? "Choose a work budget before starting" : `Work limit USD ${(budget / 100).toFixed(2)}`}</span></div>
    {(error || failure || notice) && <div className="research-notices">{failure && <p className="research-failure" role="alert"><strong>Needs attention</strong>{failure}</p>}{error && <p className="burrow-error" role="alert">{error}</p>}{notice && <p className="research-notice" role="status">{notice}</p>}</div>}
    <div className="research-mobile-tabs" role="group" aria-label="Task view"><button aria-pressed={mobilePane === "conversation"} onClick={() => setMobilePane("conversation")}>Conversation</button><button aria-pressed={mobilePane === "result"} onClick={() => setMobilePane("result")}>Result{hasNewResult || task.proposed_result ? " · New" : ""}</button></div>
    <div className="research-layout">
    <section className="research-conversation" aria-label="Conversation with Kikka"><div className="research-scroll" ref={conversationPane} tabIndex={-1} onScroll={() => remember(tab, seenSeq, "conversation")}>
    {(returning || hasNewResult || task.proposed_result) && <div className="research-return"><div><strong>{hasNewResult || task.proposed_result ? "New saved work" : "Welcome back"}</strong><p>{task.proposed_result ? "A proposed revision needs your decision. Your edits are unchanged." : hasNewResult ? "The result changed since your last reading point." : "Your reading place is saved in this tab."}</p></div><button className="burrow-secondary" onClick={pickUp}>Pick up here</button></div>}
    <div className="research-user-message"><span>You</span><p data-selection-content>{task.request}</p></div>
    {!task.travel && view?.agent.computer_workspace && <PrivateBrowser key={`${token}:${task.id}:${view.agent.computer_workspace}`} token={token} taskId={task.id} visible />}
    {task.travel && <TravelProgress token={token} id={task.id} />}
    <div data-selection-content>
    <KikkaReply revision={task.version} activity={stopped ? "stopped" : failure ? "error" : status === "Working" || stopping ? "working" : status === "Ready" ? "ready" : "needs-you"} text={activity} />
    </div>
    {lastInstruction && <p className="research-receipt" role="status"><span aria-hidden="true">{lastInstruction[3] === "sent" ? "✓ " : ""}</span>Your last instruction · {followUpLabel(lastInstruction[3])}{lastInstruction[3] === "sent" && <small>Delivery confirmed. Read status isn’t available yet.</small>}</p>}
    {!!view?.commands.filter(c => c[1] !== "stop").length && <details className="burrow-request-details"><summary>Your follow-ups</summary>{view.commands.filter(c => c[1] !== "stop").map(c => <div className="research-user-message" key={c[0]}><span>Your instruction · {followUpLabel(c[3])}</span><p>{c[2]}</p></div>)}</details>}
    {(baseline || task.proposed_result) && <div className="research-update"><h2>{task.proposed_result ? "Your edits are protected" : "A saved result you can change"}</h2><p>{task.proposed_result ? "Compare both versions before choosing which to keep." : "See the exact differences between saved versions."}</p><button className="burrow-secondary" onClick={showChanges}>What changed?</button></div>}
    {!view && <section className="burrow-permission"><h2>{task.travel ? "Run this fixture trip?" : "Research public pages?"}</h2>
      {task.travel && <p><strong>Fixture demo — no real booking.</strong> Allow &amp; start runs the normal approved model work, then the server-controlled fixture travel workflow under your saved mandate and traveler profiles. The work budget below is separate from the trip maximum. No real purchase or additional spend permission is granted here.</p>}
      <p>{routing?.preview[role] ? `Your request, source information and relevant saved choices are shared with ${new URL(routing.preview[role].endpoint).hostname}.` : routing?.catalog.length ? "Your request, source information and relevant saved choices are shared with the service chosen for this task." : routing ? "Your request, source information and relevant saved choices are shared with OpenAI." : "We can’t confirm which service will receive your request, so Kikka can’t start yet."} Saved choices include your personal preferences, this project’s requirements and your notes—not your Ohiyo chats. {task.travel ? "This trip uses simulated inventory and research only. Traveler profiles stay on this server; the model cannot change your mandate or authorize spending." : "You can review them in From our previous work. Kikka can read the allowed public pages and save screenshots. No signing in, purchases or account changes."}</p>
      {!!routing?.catalog.length && <details><summary>Advanced model details</summary><label>Model role<select value={role} onChange={e => setRole(e.target.value as ModelRole)}>{modelRoles.map(r => <option key={r} value={r}>{r}</option>)}</select></label>{routing.preview[role] ? <RouteDisclosure route={routing.preview[role]} /> : <p className="burrow-small">No resolved route for this role. Funding unavailable.</p>}{role !== "summary" && routing.preview.summary && <details><summary>Summary model · same spending cap</summary><RouteDisclosure route={routing.preview.summary} /></details>}</details>}
      {subscriptionOnly ? <p className="burrow-small">Uses your subscription allowance. This task allows up to 20 model requests, including follow-ups and summaries. Provider limits and account billing settings still apply; Burrow cannot report your remaining plan allowance. No paid API fallback.</p> : <><label>Maximum cost for this work (US cents)<input type="number" min={zeroPrice ? 0 : 1} max={zeroPrice ? 0 : 50} readOnly={zeroPrice} value={cents} onChange={e => setCents(Number(e.target.value))} /></label>{zeroPrice && <p className="burrow-small">Free service only. Kikka won’t switch to a paid service.</p>}</>}<p className="burrow-small">Follow-ups and summaries share this same limit. If a request is interrupted and its outcome is unclear, Kikka pauses rather than repeating it. Prices shown are estimates, not final bills. A regional page does not prove you can sign up or buy there. This task keeps the service you approved.</p><button className="burrow-primary" disabled={!loaded || !routingLoaded || !routing || busy || !canRun || (!!routing.catalog.length && modelRoles.some(r => !routing.preview[r])) || !Number.isInteger(cents) || cents < (zeroPrice ? 0 : 1) || cents > (zeroPrice ? 0 : 50)} onClick={() => void start()}>{busy ? "Starting…" : "Allow & start"}</button>{routingLoaded && !routing && <button className="burrow-secondary" onClick={() => { void api.modelRouting(token).then(setRouting).catch(() => setError("Couldn’t check the connection. Kikka hasn’t started this task.")); }}>Check connection again</button>}</section>}
    </div>
    {instructionAllowed && <form className="burrow-composer research-composer" onSubmit={e => { e.preventDefault(); void control(active ? "steer" : "continue"); }}>
      <label htmlFor="research-instruction">{active ? "Change what Kikka is researching" : "Ask for a revision"}</label>
      <textarea ref={instructionInput} id="research-instruction" rows={2} maxLength={8000} value={instruction} onChange={e => setInstruction(e.target.value)} onKeyDown={submitPromptOnEnter} aria-describedby="research-send-hint" placeholder="Make this shorter and add minimum order quantities…" />
      <small className="burrow-small" id="research-send-hint">Enter to send · Shift+Enter for a new line</small>
      <div>
        <span>{active ? "Kikka will use this when the current step finishes." : "Uses the remaining approved work budget."}</span>
        <details ref={emojiPicker} className="research-emoji">
          <summary aria-label="Add emoji" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); if (emojiPicker.current) emojiPicker.current.open = false; instructionInput.current?.focus(); } }}>☺</summary>
          <div role="group" aria-label="Choose an emoji">{[["😊", "Smile"], ["👍", "Thumbs up"], ["🎉", "Celebrate"], ["✨", "Sparkles"], ["❤️", "Heart"], ["🐾", "Paw prints"]].map(([emoji, label]) => <button key={label} type="button" aria-label={label} disabled={busy} onClick={() => insertEmoji(emoji)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); if (emojiPicker.current) emojiPicker.current.open = false; instructionInput.current?.focus(); } }}>{emoji}</button>)}</div>
        </details>
        <button type="submit" className="burrow-primary" disabled={busy || !instruction.trim()}>{busy ? "Sending…" : active ? "Send instruction" : "Allow & revise"}</button>
      </div>
    </form>}
    <p className="research-scope-note">{task.travel ? "Fixture trip only. No real reservation or charge." : "Research only. Nothing is ordered or sent."}</p></section>
    <section className="research-result-pane" aria-label="Saved work"><div className="research-result-tabs" role="group" aria-label="Saved work view">{(["result", "sources", "activity"] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => openTab(t)}>{t === "result" ? "Result" : t === "sources" ? `Sources (${evidence.length})` : "Activity"}</button>)}</div><div className="research-scroll" ref={resultPane} tabIndex={-1} onScroll={() => remember(tab, seenSeq, "result")}>
    <div hidden={tab !== "result"} data-selection-content>
    {review && <section className="research-changes" ref={changes} tabIndex={-1} aria-label="What changed">
      <header><h2>What changed?</h2><button className="burrow-link" onClick={() => setReview(null)}>Close changes</button></header>
      <p className="burrow-small">{task.proposed_result ? "Your current edited result → proposed revision" : "Earlier saved result → current result"}</p>
      <p className="research-budget">{subscriptionOnly ? "Your plan · The same 20-request task limit still applies." : budget == null ? "No work budget is approved." : `Your existing work limit: USD ${(budget / 100).toFixed(2)}. Unchanged.`} This is not a purchase budget.</p>
      {task.proposed_result && <>
        <div className="research-decisions"><button className="burrow-primary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(true)}>Use this revision</button><button className="burrow-secondary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(false)}>Keep my edits</button></div>
        <p className="burrow-small">Neither choice starts research, raises the budget or authorizes a purchase.</p>
        {editor && <p className="burrow-small">Save or cancel your open result edit before deciding.</p>}
        {review.version !== task.version && <p className="burrow-error" role="status">This task changed. Reopen What changed? before deciding.</p>}
      </>}
      {review.before ? parseTravelResult(review.before) || parseTravelResult(review.after) ? <><h3>Earlier saved version</h3><SavedResearchText text={review.before} /><h3>Revised saved version</h3><SavedResearchText text={review.after} /></> : <RevisionDiff before={review.before} after={review.after} /> : <p>The earlier result is unavailable. Review the full proposal below.</p>}
      {task.proposed_result && <details><summary>Full proposed revision</summary><SavedResearchText text={review.after} /></details>}
    </section>}
    {task.result && <section className="burrow-result"><header><div><p className="burrow-eyebrow">SAVED FOR YOU</p><h2>Your comparison</h2></div>{task.state === "draft_ready" && !editor && <button className="burrow-secondary" onClick={() => setEditor({ text: task.result, version: task.version })}>Edit result</button>}</header>{editor ? <><label className="sr-only" htmlFor="research-result">Edit saved comparison</label><textarea id="research-result" value={editor.text} maxLength={100000} onChange={e => setEditor({ ...editor, text: e.target.value })} /><div className="burrow-editor-actions"><button className="burrow-secondary" onClick={() => setEditor(null)}>Cancel</button><button className="burrow-primary" disabled={busy || !editor.text.trim()} onClick={() => { setBusy(true); void api.saveBurrowResult(token, { ...task, version: editor.version }, editor.text).then(t => { onUpdate(t); setEditor(null); }).catch(e => setError(taskActionError(e, "Couldn’t confirm your save. Your edits are still here; refresh before trying again."))).finally(() => setBusy(false)); }}>Save edits</button></div></> : comparison ? <Comparison value={comparison} /> : <SavedResearchText text={task.result} />}{task.manual_notes && <div className="burrow-document"><strong>Your notes</strong><p>{task.manual_notes}</p></div>}<footer>{task.manual_edited ? "Your manual edits are protected. New revisions need your review." : "Sources may change. Review eligibility and tax details before acting."}</footer></section>}
    {!task.result && <div className="research-empty"><h2>{task.state === "working" ? "The research is underway" : "Your result will live here"}</h2><p>No saved comparison yet. Kikka’s actual activity is shown in the conversation.</p></div>}
    <div ref={context} tabIndex={-1}><TaskContext ref={memoryDraft} task={task} token={token} onUpdate={onUpdate} onDirtyChange={setContextDirty} /></div>
    {!!view?.history.length && <details className="burrow-request-details"><summary>Previous versions ({view.history.length})</summary>{view.history.map(([id, result], index) => <details key={id}><summary>Previous version {view.history.length - index}</summary><SavedResearchText text={result} /></details>)}</details>}
    </div>
    <div hidden={tab !== "sources"}><h2>Sources & evidence</h2><p className="burrow-small">Captured pages support this task, not signup or payment eligibility.</p>{evidence.length ? evidence.map(e => <div className="research-source" key={e.id}><p>{e.url}</p><small>{e.capturedAt} · Regional page only</small><button className="burrow-secondary" onClick={() => void showEvidence(e.id!)}>View screenshot</button></div>) : <p className="burrow-small">No captured evidence yet. A finished answer is not proof on its own.</p>}{image && <section className="burrow-request-details"><button className="burrow-secondary" onClick={() => setImage(null)}>Close screenshot</button><p>{image.url}<br />{image.capturedAt} · Regional page only</p><img src={image.src} alt={`Saved public-page evidence for ${image.url}`} style={{ maxWidth: "100%" }} /></section>}</div>
    <div hidden={tab !== "activity"}><h2>Activity</h2><p className="burrow-small">{activity}</p>{view?.agent.routing && <details className="burrow-request-details"><summary>Technical details · services used</summary>{modelRoles.map(r => view.agent.routing?.[r] && <div key={r}><h3>{r}</h3><RouteDisclosure route={view.agent.routing[r]} /></div>)}</details>}{view?.agent.usage && <details className="burrow-request-details"><summary>Technical details · costs & usage ({view.agent.usage.length})</summary><p>These cost estimates are not final bills. Missing costs are unknown, not zero. Amounts held against the budget are not necessarily charges.</p>{view.agent.usage.map(u => <div key={u.id}><p>Request {u.id} · {u.status === "complete" ? "Response received" : "Waiting for a response"} · {u.role}<br />{u.canonicalModel} → {u.providerModelId} · connection {u.connectionId} · Funded by {u.fundedBy === "you" ? "you" : "Ohiyo"}<br />Tokens: {(["input", "output", "cacheRead", "cacheWrite"] as const).map(k => `${k}: ${u.usage?.[k] ?? "unavailable"}`).join(" · ")}<br />Estimated cost: {u.reportedCostMicros == null ? "unavailable" : `USD ${(u.reportedCostMicros / 1_000_000).toFixed(6)}`}<br />Held against this budget: USD {(u.reservationMicros / 1_000_000).toFixed(6)}</p></div>)}</details>}<p className="burrow-small">Your reading place is remembered while you use this tab and account. Your saved work stays in Burrow. Opening a task never restarts it.</p></div>
    </div></section></div>
  </article>;
}
