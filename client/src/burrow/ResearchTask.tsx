import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, getApiBase, type BurrowAgent, type BurrowCommandReceipt, type BurrowComputerWorkspace, type BurrowTask, type ModelRole, type ModelRouting } from "../api";
import { apiStatus } from "../lib/apiErrors";
import KikkaReply from "./KikkaReply";
import { modelRoles, RouteDisclosure } from "./ModelSettings";
import TaskContext, { type MemoryDraft } from "./TaskContext";
import SelectionActions from "./SelectionActions";
import Comparison from "./ResearchComparison";
import ResearchWorkspace from "./ResearchWorkspace";
import PrivateBrowser from "./PrivateBrowser";
import PresentationReview from "./PresentationReview";
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

function RecentCommands({ token, taskId, events }: { token: string; taskId: string; events: BurrowAgent["events"] }) {
  const [receipts, setReceipts] = useState<Record<string, { loading?: boolean; receipt?: BurrowCommandReceipt; error?: string }>>({});
  const pending = useRef(new Set<string>());
  const commands = [...new Map(events.filter(e => e.type === "computer" && e.data.operation === "shell" && e.data.request_id)
    .slice().sort((a, b) => a.seq - b.seq).map(e => [e.data.request_id!, e])).values()].sort((a, b) => b.seq - a.seq);
  async function showOutput(id: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setReceipts(current => ({ ...current, [id]: { loading: true } }));
    try {
      const receipt = await api.burrowCommandReceipt(token, taskId, id);
      setReceipts(current => ({ ...current, [id]: { receipt } }));
    } catch {
      setReceipts(current => ({ ...current, [id]: { error: "Output unavailable. The command’s outcome is not confirmed by this lookup. View output again to check the same receipt; this never reruns the command." } }));
    } finally { pending.current.delete(id); }
  }
  return <section aria-label="Recent commands"><h3>Recent commands</h3>
    <p className="burrow-small">Commands in the available task events, not a complete history. View output reads a saved receipt; it never runs a command. A complete receipt does not mean the command passed.</p>
    {!commands.length && <p className="burrow-small">No shell commands in the available events.</p>}
    {commands.map(event => {
      const id = event.data.request_id!;
      const saved = receipts[id];
      const receipt = saved?.receipt;
      const output = receipt?.operation === "shell" ? receipt.output : null;
      return <section key={id} className="burrow-request-details" aria-label={`Command ${id}`}>
        <h4 className="research-preserved-text">Command {id}</h4><p className="burrow-small">{event.data.phase === "returned" ? "Returned" : event.data.phase === "requested" ? "Requested" : "Phase unavailable"} · Event status: {event.data.status || "unavailable"}</p>
        <button className="burrow-secondary" disabled={saved?.loading} onClick={() => void showOutput(id)}>{saved?.loading ? "Loading output…" : "View output"}</button>
        {saved?.loading && <p role="status">Reading saved receipt…</p>}
        {saved?.error && <p className="burrow-error" role="alert">{saved.error}</p>}
        {receipt && <div className="burrow-document">
          <p>Receipt status: {receipt.status || "unavailable"}</p>
          {receipt.status !== "complete" && <p role="status">Command outcome is uncertain; no success is confirmed.</p>}
          {receipt.reason && <p>{receipt.reason}</p>}
          {output ? <>
            <h4>Arguments (argv)</h4><pre className="research-preserved-text">{output.argv ? JSON.stringify(output.argv, null, 2) : "Arguments unavailable in this receipt."}</pre>
            <p>Exit code: {output.exit_code ?? "unavailable"}{typeof output.exit_code === "number" && output.exit_code !== 0 ? " · Non-zero exit; command failed." : output.exit_code === 0 ? " · Zero exit reported; review output and checks." : " · Command success is not confirmed."}</p>
            {output.timed_out && <p role="status">Command timed out.</p>}
            {output.truncated && <p role="status">Output was truncated; some text is missing.</p>}
            {output.spawn_error && <p role="status">Command could not start.</p>}
            <h4>stdout</h4><pre className="research-preserved-text">{output.stdout === "" ? "(empty)" : output.stdout ?? "unavailable"}</pre>
            <h4>stderr</h4><pre className="research-preserved-text">{output.stderr === "" ? "(empty)" : output.stderr ?? "unavailable"}</pre>
          </> : <p>Shell output unavailable. Command success is not confirmed.</p>}
        </div>}
      </section>;
    })}
  </section>;
}

function ProjectMaterial({ text }: { text: string }) {
  const [index, setIndex] = useState(0);
  const [readAll, setReadAll] = useState(false);
  const headings = [...text.matchAll(/^#{1,3}\s+Slide\s+\d+\s*[:—–-]\s*.+$/gim)];
  if (headings.length < 2) return <SavedResearchText text={text} />;
  const slides = headings.map((heading, i) => text.slice(heading.index, headings[i + 1]?.index));
  const introduction = text.slice(0, headings[0].index);
  return <div className="project-presentation">
    <div className="project-material-tools"><span>Presentation · {slides.length} slides</span><button className="burrow-link" onClick={() => setReadAll(!readAll)}>{readAll ? "Slide view" : "Read all"}</button></div>
    {readAll ? <SavedResearchText text={text} /> : <>
      {introduction.trim() && <SavedResearchText text={introduction} />}
      <div className="project-slide" aria-label={`Slide ${index + 1}`}><SavedResearchText text={slides[index]} /></div>
      <div className="project-slide-navigation"><button className="burrow-secondary" aria-label="Previous slide" disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button><span role="status">{index + 1} / {slides.length}</span><button className="burrow-secondary" aria-label="Next slide" disabled={index === slides.length - 1} onClick={() => setIndex(index + 1)}>→</button></div>
    </>}
  </div>;
}

export default function ResearchTask({ task, token, canRun, onUpdate, onDirtyChange, projectPlanning = false, children }: { task: BurrowTask; token: string; canRun: boolean; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void; projectPlanning?: boolean; children?: ReactNode }) {
  const selectionRoot = useRef<HTMLElement>(null);
  const [projectKnowledge, setProjectKnowledge] = useState(false);
  const memoryDraft = useRef<MemoryDraft>(null);
  const [view, setView] = useState<BurrowAgent | null>(null);
  const codingEligible = task.kind === "writing" && task.format === "document" && !task.template && !task.comparison && !task.travel && task.routine_id == null && task.routine_version == null;
  const coding = view ? view.agent.coding === true : task.coding === true && codingEligible;
  const [computers, setComputers] = useState<BurrowComputerWorkspace[] | null>(null);
  const [computer, setComputer] = useState("");
  const [computerError, setComputerError] = useState("");
  const [computerRefresh, setComputerRefresh] = useState(0);
  const admitted = !!view;
  useEffect(() => {
    if (!coding || admitted) return;
    let alive = true;
    setComputers(null); setComputerError("");
    void api.burrowComputerWorkspaces(token).then(next => {
      if (alive) { setComputers(next); setComputer(current => next.some(c => c.id === current) ? current : ""); }
    }).catch(() => { if (alive) setComputerError("Saved repository computers are unavailable. No coding work has started."); });
    return () => { alive = false; };
  }, [token, coding, admitted, computerRefresh]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const instructionInput = useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useRef<HTMLDetailsElement>(null);
  const [editor, setEditor] = useState<{ text: string; version: number } | null>(null);
  const presentationInput = useRef<HTMLTextAreaElement>(null);
  const editing = editor !== null;
  useEffect(() => { if (editing) presentationInput.current?.focus(); }, [editing]);
  const [contextDirty, setContextDirty] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [presentationDirty, setPresentationDirty] = useState(false);
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
  const dirty = contextDirty || workspaceDirty || presentationDirty || !!instruction.trim() || (!!editor && editor.text !== task.result);
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [cents, setCents] = useState(25);
  const [routing, setRouting] = useState<ModelRouting | null>(null);
  const [routingLoaded, setRoutingLoaded] = useState(false);
  const [role, setRole] = useState<ModelRole>(coding ? "general" : "research");
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
    if (busy || view || !loaded || !canRun || (coding && (!codingEligible || !computers?.some(c => c.id === computer)))) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.startBurrowAgent(token, task, cents, routing?.catalog.length ? role : undefined, routing?.catalog.length ? routing.preview : undefined, { ...(coding ? { coding: true, computer_workspace: computer } : {}), ...(projectPlanning && projectKnowledge ? { allow_project_knowledge: true } : {}) }); const next = await api.burrowAgent(token, task.id); setView(next); onUpdate(next.task); }
    catch (e) { setError(coding && (apiStatus(e) === 400 || apiStatus(e) === 503) ? "Coding could not start with this task, connection and saved computer. A saved computer does not mean its coding engine is ready. Check the configuration with the person running this Burrow." : taskActionError(e, "Couldn’t confirm whether work started. Reopen the task before trying again.")); }
    finally { setBusy(false); }
  }
  async function control(action: "steer" | "stop" | "continue", requirementsRevision?: number): Promise<boolean> {
    // An uncertain instruction must not prevent the owner from requesting Stop.
    const queue = action === "stop" ? pendingStop : pending;
    const message = action === "stop" ? "" : requirementsRevision === undefined ? instruction : `Update the comparison using saved brief ${requirementsRevision}.`;
    if (queue.current && (queue.current.action !== action || queue.current.message !== message)) {
      setError("Kikka hasn’t confirmed your previous instruction. Reopen this task before sending a different one. You can still choose Stop."); return false;
    }
    queue.current ??= { id: crypto.randomUUID(), action, message };
    setBusy(true); setError(""); setNotice("");
    try {
      const p = queue.current;
      onUpdate(await api.controlBurrowAgent(token, task, p.id, p.action, p.message, requirementsRevision));
      const next = await api.burrowAgent(token, task.id); setView(next); onUpdate(next.task);
      queue.current = null;
      if (action === "stop") pending.current = null; else if (requirementsRevision === undefined) setInstruction("");
      return true;
    } catch (e) { setError(taskActionError(e, action === "stop" ? "Couldn’t confirm that Stop arrived. Trying Stop again checks the same request. Kikka is not confirmed stopped yet." : "Couldn’t confirm that your instruction arrived. Trying again checks the same request rather than sending a new one.")); return false; }
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
  async function saveEdits() {
    if (!editor || busy) return;
    setBusy(true); setError("");
    try { onUpdate(await api.saveBurrowResult(token, { ...task, version: editor.version }, editor.text)); setEditor(null); }
    catch (e) { setError(taskActionError(e, "Couldn’t confirm your save. Your edits are still here; refresh before trying again.")); }
    finally { setBusy(false); }
  }
  const startDisabled = !loaded || !routingLoaded || !routing || busy || !canRun || (coding && (!codingEligible || !computers?.some(c => c.id === computer))) || (!!routing.catalog.length && modelRoles.some(r => !routing.preview[r])) || !Number.isInteger(cents) || cents < (zeroPrice ? 0 : 1) || cents > (zeroPrice ? 0 : 50);
  if (projectPlanning) return <article className="project-writing" aria-label="Conversation with Kikka">
    <div className="project-thread" role="region" aria-label="Messages">
    <div className="project-message user"><span className="sr-only">You</span><p>{task.request}</p></div>
    <header><div className="project-speaker"><strong>Kikka</strong>{view && <span className="project-status" role="status">{status}</span>}</div>{active && <button className="burrow-secondary" disabled={busy || !!stopping || !view?.connected || view?.agent.phase === "review"} onClick={() => void control("stop")}>{stopping ? "Stopping…" : "Stop"}</button>}</header>
    {error && <p className="burrow-error" role="alert">{error}</p>}
    {failure && <p className="burrow-error" role="alert">{failure}</p>}
    <p className="project-notice" role="status">{notice}</p>
    {!view && <section className="project-start" aria-label="Chat permission">
      <h3>Ready to help. May I use AI for this?</h3>
      <p>Your request and relevant saved choices, including your project plan, will be shared with {routing?.preview[role] ? new URL(routing.preview[role].endpoint).hostname : routing ? "OpenAI" : "your AI service"}. Your Ohiyo chats are not included.</p>
      <label className="project-consent"><input type="checkbox" checked={projectKnowledge} disabled={busy} onChange={e => setProjectKnowledge(e.target.checked)} /><span>Let Kikka suggest plan changes and helpers.<small>You review every suggestion. Kikka cannot approve or enable it.</small></span></label>
      {subscriptionOnly ? <p className="project-caption">Uses your subscription, up to 20 requests including revisions. No paid fallback.</p> : zeroPrice ? <p className="project-caption">Free service only. No paid fallback.</p> : <label className="project-cost">Spending limit (US cents)<input type="number" min={1} max={50} value={cents} onChange={e => setCents(Number(e.target.value))} /><small>Up to 50 cents. Revisions share this limit; costs are estimates.</small></label>}
      <div className="project-actions"><button className="burrow-primary" disabled={startDisabled} onClick={() => void start()}>{busy ? "Starting…" : "Allow & start chat"}</button></div>
      {(!canRun || (routingLoaded && !routing)) && <p role="status" className="project-caption">{!canRun ? "Kikka isn’t connected right now. You can still write and review your plan without AI." : "We couldn’t confirm the AI connection. No work has started."}</p>}
      {routingLoaded && !routing && <button className="burrow-secondary" onClick={() => { void api.modelRouting(token).then(setRouting).catch(() => setError("Couldn’t check the connection. No work has started.")); }}>Check connection</button>}
      <details><summary>What you’re allowing</summary><p>Writing and reading allowed public sources only. No publishing, purchases or account changes. Follow-ups use this same service and limit. If a response is lost, Kikka pauses instead of automatically repeating a paid request.</p>{!!routing?.catalog.length && <ul>{modelRoles.map(r => { const route = routing.preview[r]; return route && <li key={r}>{r === "general" ? "General assistance" : r === "research" ? "Writing" : r === "review" ? "Review" : "Summaries"}: {route.providerModelId} via {new URL(route.endpoint).hostname}. {route.connectionId.startsWith("subscription-") ? "Uses your subscription." : route.fundedBy === "you" ? "Paid by you, within your limit." : "Provided by Ohiyo, within your limit."}</li>; })}</ul>}{subscriptionOnly && <p>Your provider’s allowance and billing settings apply. Your remaining allowance isn’t available here.</p>}</details>
    </section>}
    {view && (active || stopped || view.agent.phase === "review") && <p className="project-caption" role="status">{activity}</p>}
    {task.result && <section className="burrow-result" aria-label="Saved material"><header><span className="project-caption">Saved for you</span>{task.state === "draft_ready" && !editor && <button className="burrow-link" onClick={() => setEditor({ text: task.result, version: task.version })}>Edit</button>}</header>{editor ? <><label htmlFor="presentation-draft" className="sr-only">Edit material</label><textarea ref={presentationInput} id="presentation-draft" rows={14} maxLength={100000} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} /><div className="project-actions"><button className="burrow-primary" disabled={busy || !editor.text.trim()} onClick={() => void saveEdits()}>Save edits</button><button className="burrow-secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div></> : <ProjectMaterial key={task.result} text={task.result} />}<footer>Check facts and sources in Review &amp; download before sharing or exporting to PowerPoint.</footer></section>}
    {view && <>
      {!!view.commands.filter(c => c[1] !== "stop").length && <details className="project-history"><summary>Your earlier messages</summary>{view.commands.filter(c => c[1] !== "stop").map(c => <div className="project-message user" key={c[0]}><p>{c[2]}</p><small className="project-caption">{followUpLabel(c[3])}</small></div>)}</details>}
      {task.proposed_result && !review && <div className="project-revision"><p>Kikka suggested a revision. Your edits are unchanged.</p><button className="burrow-secondary" onClick={showChanges}>Review revision</button></div>}
      {review && task.proposed_result && <section className="project-revision" aria-label="Suggested revision"><h3>Review the revision</h3><div className="project-comparison"><div><h4>Your saved version</h4><SavedResearchText text={review.before ?? ""} /></div><div><h4>Suggested version</h4><SavedResearchText text={review.after} /></div></div>{review.version !== task.version && <p role="alert">A newer revision arrived. Close this review and open it again before deciding.</p>}<div className="project-actions"><button className="burrow-primary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(true)}>Use this revision</button><button className="burrow-secondary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(false)}>Keep my edits</button><button className="burrow-link" onClick={() => setReview(null)}>Close review</button></div></section>}
      {!!view.history.length && <details className="project-history"><summary>Previous versions</summary>{view.history.map(([id, result], index) => <details key={id}><summary>Version {view.history.length - index}</summary><SavedResearchText text={result} /></details>)}</details>}
    </>}
    {task.result && <div hidden={!!editor}><PresentationReview token={token} task={task} onDirtyChange={setPresentationDirty} /></div>}
    {children}
    <details className="project-history"><summary>Saved preferences</summary><TaskContext ref={memoryDraft} task={task} token={token} onUpdate={onUpdate} onDirtyChange={setContextDirty} /></details>
    </div>
    <form className="project-followup" onSubmit={e => { e.preventDefault(); if (instructionAllowed && !busy && !editor && instruction.trim()) void control(active ? "steer" : "continue"); }}><label className="sr-only" htmlFor="presentation-instruction">Message Kikka</label><textarea id="presentation-instruction" ref={instructionInput} rows={2} maxLength={8000} value={instruction} disabled={busy || !instructionAllowed} onChange={e => setInstruction(e.target.value)} onKeyDown={submitPromptOnEnter} placeholder={view ? "Message Kikka…" : "Allow AI above to start chatting…"} /><div className="project-actions"><span className="project-caption">{view ? subscriptionOnly ? "Uses your existing allowance" : `Within your limit · $${((budget ?? 0) / 100).toFixed(2)}` : "AI is off until you allow it"}</span><button type="submit" className="burrow-primary" disabled={!instructionAllowed || busy || !instruction.trim() || !!editor} aria-label="Send message">{busy ? "Sending…" : "Send"}<span aria-hidden="true"> ↑</span></button></div><p className="project-composer-hint">Changes need your review. Nothing installs or activates.</p></form>
  </article>;
  return <article ref={selectionRoot} className={`research-studio pane-${mobilePane}`}>
    <SelectionActions root={selectionRoot} onRemember={selected => { openTab("result"); memoryDraft.current?.prepare(selected); }} onQuote={instructionAllowed && !busy ? selected => {
      const quote = selected.split("\n").map(line => `> ${line}`).join("\n");
      const next = `${instruction}${instruction ? "\n\n" : ""}${quote}\n\n`;
      if (next.length > 8000) { setError("There isn’t enough room for this quote. Shorten your selection or your draft; nothing was replaced."); return; }
      setInstruction(next); setMobilePane("conversation");
      requestAnimationFrame(() => { instructionInput.current?.focus(); instructionInput.current?.setSelectionRange(next.length, next.length); });
    } : undefined} />
    <header className="research-toolbar"><div><p className="burrow-small">{task.project ?? (coding ? "Your repository task" : "Your research")}</p><h1>{task.request.length > 100 ? `${task.request.slice(0, 100)}…` : task.request}</h1></div><span className={`burrow-status ${task.state}`} role="status">{status}</span><button className="burrow-secondary" disabled={!active || busy || stopping || !view?.connected || view?.agent.phase === "review"} onClick={() => void control("stop")}>{stopping ? "Stopping…" : "Stop"}</button></header>
    <div className="research-controls"><details><summary>Original request</summary><p>{task.request}</p></details><details><summary>Scope</summary><p>{coding ? "Kikka may read and edit repository files and run test commands on the selected saved computer. No publishing, pushing or deploying. Follow-ups use the same approved scope and model budget. Stop does not undo file edits already made." : "Kikka can only read the public pages allowed for this task. No signing in, contacting suppliers, purchases or account changes. Saved choices do not give permission to take action."}</p></details><button className="burrow-link" onClick={() => { openTab("result"); requestAnimationFrame(() => { context.current?.scrollIntoView({ block: "start" }); context.current?.focus(); }); }}>Saved choices</button><span className="research-budget">{subscriptionOnly ? "Your plan · Up to 20 requests for this task" : budget == null ? "Choose a work budget before starting" : `Work limit USD ${(budget / 100).toFixed(2)}`}</span></div>
    <p className="research-current-activity" role="status">{!view && !canRun ? coding ? "Coding is unavailable: no connected worker. Your request is saved; no work has started." : "Research worker not connected. Your saved workspace is still available." : activity}</p>
    {(error || failure || notice) && <div className="research-notices">{failure && <p className="research-failure" role="alert"><strong>Needs attention</strong>{failure}</p>}{error && <p className="burrow-error" role="alert">{error}</p>}{notice && <p className="research-notice" role="status">{notice}</p>}</div>}
    <div className="research-mobile-tabs" role="group" aria-label="Task view"><button aria-pressed={mobilePane === "conversation"} onClick={() => setMobilePane("conversation")}>Conversation</button><button aria-pressed={mobilePane === "result"} onClick={() => setMobilePane("result")}>Result{hasNewResult || task.proposed_result ? " · New" : ""}</button></div>
    <div className="research-layout">
    <section className="research-conversation" aria-label="Conversation with Kikka"><div className="research-scroll" ref={conversationPane} tabIndex={-1} onScroll={() => remember(tab, seenSeq, "conversation")}>
    {(returning || hasNewResult || task.proposed_result) && <div className="research-return"><div><strong>{hasNewResult || task.proposed_result ? "New saved work" : "Welcome back"}</strong><p>{task.proposed_result ? "A proposed revision needs your decision. Your edits are unchanged." : hasNewResult ? "The result changed since your last reading point." : "Your reading place is saved in this tab."}</p></div><button className="burrow-secondary" onClick={pickUp}>Pick up here</button></div>}
    <div className="research-user-message"><span>You</span><p data-selection-content>{task.request}</p></div>
    {!coding && !task.travel && view?.agent.computer_workspace && <PrivateBrowser key={`${token}:${task.id}:${view.agent.computer_workspace}`} token={token} taskId={task.id} visible />}
    {task.travel && <TravelProgress token={token} id={task.id} />}
    <div data-selection-content>
    <KikkaReply revision={task.version} activity={stopped ? "stopped" : failure ? "error" : status === "Working" || stopping ? "working" : status === "Ready" ? "ready" : "needs-you"} text={activity} />
    </div>
    {lastInstruction && <p className="research-receipt" role="status"><span aria-hidden="true">{lastInstruction[3] === "sent" ? "✓ " : ""}</span>Your last instruction · {followUpLabel(lastInstruction[3])}{lastInstruction[3] === "sent" && <small>Delivery confirmed. Read status isn’t available yet.</small>}</p>}
    {!!view?.commands.filter(c => c[1] !== "stop").length && <details className="burrow-request-details"><summary>Your follow-ups</summary>{view.commands.filter(c => c[1] !== "stop").map(c => <div className="research-user-message" key={c[0]}><span>Your instruction · {followUpLabel(c[3])}</span><p>{c[2]}</p></div>)}</details>}
    {(baseline || task.proposed_result) && <div className="research-update"><h2>{task.proposed_result ? "Your edits are protected" : "A saved result you can change"}</h2><p>{task.proposed_result ? "Compare both versions before choosing which to keep." : "See the exact differences between saved versions."}</p><button className="burrow-secondary" onClick={showChanges}>What changed?</button></div>}
    {!view && !canRun && !coding && <section className="research-empty"><h2>Your workspace is ready</h2><p>You can save requirements and questions now. A connected research worker is needed before Kikka can read public pages. Saving these records does not start a model call.</p></section>}
    {!view && (canRun || coding) && <section className="burrow-permission"><h2>{coding ? "Work on this repository?" : task.travel ? "Run this fixture trip?" : "Research public pages?"}</h2>
      {coding && <>
        <label>Repository computer<select value={computer} disabled={busy || !computers?.length} onChange={e => setComputer(e.target.value)} aria-describedby="coding-computer-help"><option value="">Choose a saved computer…</option>{computers?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <p id="coding-computer-help" className="burrow-small">Operator-configured scopes, not proof that a coding engine is ready. Saving or selecting starts no model work and provisions nothing.</p>
        {computerError ? <p className="burrow-error" role="alert">{computerError}</p> : computers === null ? <p role="status">Loading saved repository computers…</p> : !computers.length && <p role="status">No repository computers are configured for your account. Ask the person running this Burrow to configure one; Kikka cannot create one here.</p>}
        {(computerError || computers?.length === 0) && <button className="burrow-secondary" disabled={busy} onClick={() => setComputerRefresh(value => value + 1)}>Check computers again</button>}
        <p>Allow &amp; start permits reading and editing repository files and running test commands on this computer. No publishing, pushing or deploying. File contents and command output are shared with the approved model service.</p>
      </>}
      {task.travel && <p><strong>Fixture demo — no real booking.</strong> Allow &amp; start runs the normal approved model work, then the server-controlled fixture travel workflow under your saved mandate and traveler profiles. The work budget below is separate from the trip maximum. No real purchase or additional spend permission is granted here.</p>}
      <p>{routing?.preview[role] ? `Your request, source information and relevant saved choices are shared with ${new URL(routing.preview[role].endpoint).hostname}.` : routing?.catalog.length ? "Your request, source information and relevant saved choices are shared with the service chosen for this task." : routing ? "Your request, source information and relevant saved choices are shared with OpenAI." : "We can’t confirm which service will receive your request, so Kikka can’t start yet."} Saved choices include your personal preferences, this project’s requirements and your notes—not your Ohiyo chats. {coding ? "Review saved choices in From our previous work." : task.travel ? "This trip uses simulated inventory and research only. Traveler profiles stay on this server; the model cannot change your mandate or authorize spending." : "You can review them in From our previous work. Kikka can read the allowed public pages and save screenshots. No signing in, purchases or account changes."}</p>
      {!!routing?.catalog.length && <details><summary>Advanced model details</summary><label>Model role<select value={role} onChange={e => setRole(e.target.value as ModelRole)}>{modelRoles.map(r => <option key={r} value={r}>{r}</option>)}</select></label>{routing.preview[role] ? <RouteDisclosure route={routing.preview[role]} /> : <p className="burrow-small">No resolved route for this role. Funding unavailable.</p>}{role !== "summary" && routing.preview.summary && <details><summary>Summary model · same spending cap</summary><RouteDisclosure route={routing.preview.summary} /></details>}</details>}
      {subscriptionOnly ? <p className="burrow-small">Uses your subscription allowance. This task allows up to 20 model requests, including follow-ups and summaries. Provider limits and account billing settings still apply; Burrow cannot report your remaining plan allowance. No paid API fallback.</p> : <><label>Maximum cost for this work (US cents)<input type="number" min={zeroPrice ? 0 : 1} max={zeroPrice ? 0 : 50} readOnly={zeroPrice} value={cents} onChange={e => setCents(Number(e.target.value))} /></label>{zeroPrice && <p className="burrow-small">Free service only. Kikka won’t switch to a paid service.</p>}</>}<p className="burrow-small">Follow-ups and summaries share this same limit. If a request is interrupted and its outcome is unclear, Kikka pauses rather than repeating it. Prices shown are estimates, not final bills. {coding ? "A saved result is not proof that file edits or tests succeeded. Review the reported changes and checks." : "A regional page does not prove you can sign up or buy there."} This task keeps the service you approved.</p><button className="burrow-primary" disabled={!loaded || !routingLoaded || !routing || busy || !canRun || (coding && (!codingEligible || !computers?.some(c => c.id === computer))) || (!!routing.catalog.length && modelRoles.some(r => !routing.preview[r])) || !Number.isInteger(cents) || cents < (zeroPrice ? 0 : 1) || cents > (zeroPrice ? 0 : 50)} onClick={() => void start()}>{busy ? "Starting…" : "Allow & start"}</button>{routingLoaded && !routing && <button className="burrow-secondary" onClick={() => { void api.modelRouting(token).then(setRouting).catch(() => setError("Couldn’t check the connection. Kikka hasn’t started this task.")); }}>Check connection again</button>}</section>}
    </div>
    {instructionAllowed && <form className="burrow-composer research-composer" onSubmit={e => { e.preventDefault(); void control(active ? "steer" : "continue"); }}>
      <label htmlFor="research-instruction">{active ? coding ? "Change what Kikka is coding" : "Change what Kikka is researching" : "Ask for a revision"}</label>
      <textarea ref={instructionInput} id="research-instruction" rows={2} maxLength={8000} value={instruction} onChange={e => setInstruction(e.target.value)} onKeyDown={submitPromptOnEnter} aria-describedby="research-send-hint" placeholder={coding ? "Focus on the failing test and explain the changes…" : "Make this shorter and add minimum order quantities…"} />
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
    <p className="research-scope-note">{coding ? "Repository files and test commands only. No publishing, pushing or deploying." : task.travel ? "Fixture trip only. No real reservation or charge." : "Research only. Nothing is ordered or sent."}</p></section>
    <section className="research-result-pane" aria-label="Saved work"><div className="research-result-tabs" role="group" aria-label="Saved work view">{(["result", "sources", "activity"] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => openTab(t)}>{t === "result" ? "Result" : t === "sources" ? `Sources (${evidence.length})` : "Activity"}</button>)}</div><div className="research-scroll" ref={resultPane} tabIndex={-1} onScroll={() => remember(tab, seenSeq, "result")}>
    <div hidden={tab !== "result"} data-selection-content>
    {review && <section className="research-changes" ref={changes} tabIndex={-1} aria-label="What changed">
      <header><h2>What changed?</h2><button className="burrow-link" onClick={() => setReview(null)}>Close changes</button></header>
      <p className="burrow-small">{task.proposed_result ? "Your current edited result → proposed revision" : "Earlier saved result → current result"}</p>
      <p className="research-budget">{subscriptionOnly ? "Your plan · The same 20-request task limit still applies." : budget == null ? "No work budget is approved." : `Your existing work limit: USD ${(budget / 100).toFixed(2)}. Unchanged.`} This is not a purchase budget.</p>
      {task.proposed_result && <>
        <div className="research-decisions"><button className="burrow-primary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(true)}>Use this revision</button><button className="burrow-secondary" disabled={busy || !!editor || task.state !== "draft_ready" || review.version !== task.version} onClick={() => void decide(false)}>Keep my edits</button></div>
        <p className="burrow-small">{coding ? "These choices update only the saved report, not repository files. Neither starts coding or raises the budget." : "Neither choice starts research, raises the budget or authorizes a purchase."}</p>
        {editor && <p className="burrow-small">Save or cancel your open result edit before deciding.</p>}
        {review.version !== task.version && <p className="burrow-error" role="status">This task changed. Reopen What changed? before deciding.</p>}
      </>}
      {review.before ? parseTravelResult(review.before) || parseTravelResult(review.after) ? <><h3>Earlier saved version</h3><SavedResearchText text={review.before} /><h3>Revised saved version</h3><SavedResearchText text={review.after} /></> : <RevisionDiff before={review.before} after={review.after} /> : <p>The earlier result is unavailable. Review the full proposal below.</p>}
      {task.proposed_result && <details><summary>Full proposed revision</summary><SavedResearchText text={review.after} /></details>}
    </section>}
    <ResearchWorkspace key={`${token}:${task.id}`} enabled={!!task.comparison && !task.travel} hasManualEdits={!!task.manual_edited} token={token} taskId={task.id} canUpdate={!!view?.connected && view.agent.phase === "finished" && task.state === "draft_ready" && !busy} running={active} onResearch={revision => control("continue", revision)} onDirtyChange={setWorkspaceDirty}>
    {task.result && <section className="burrow-result"><header><div><p className="burrow-eyebrow">SAVED FOR YOU</p><h2>{coding ? "Your coding report" : "Your comparison"}</h2></div>{task.state === "draft_ready" && !editor && <button className="burrow-secondary" onClick={() => setEditor({ text: task.result, version: task.version })}>Edit result</button>}</header>{editor ? <><label className="sr-only" htmlFor="research-result">{coding ? "Edit saved coding report" : "Edit saved comparison"}</label><textarea id="research-result" value={editor.text} maxLength={100000} onChange={e => setEditor({ ...editor, text: e.target.value })} /><div className="burrow-editor-actions"><button className="burrow-secondary" onClick={() => setEditor(null)}>Cancel</button><button className="burrow-primary" disabled={busy || !editor.text.trim()} onClick={() => void saveEdits()}>Save edits</button></div></> : comparison ? <Comparison value={comparison} /> : <SavedResearchText text={task.result} />}{task.manual_notes && <div className="burrow-document"><strong>Your notes</strong><p>{task.manual_notes}</p></div>}<footer>{coding ? "Review the reported file changes and tests. Editing this report does not change repository files. Your manual report edits are protected." : task.manual_edited ? "Your manual edits are protected. New revisions need your review." : "Sources may change. Review eligibility and tax details before acting."}</footer></section>}
    {!task.result && <div className="research-empty"><h2>{task.state === "working" ? coding ? "Repository work is underway" : "The research is underway" : "Your result will live here"}</h2><p>{coding ? "No saved coding report yet. Review the reported changes and test outcomes when it arrives." : "No saved comparison yet. Kikka’s actual activity is shown in the conversation."}</p></div>}
    </ResearchWorkspace>
    <div ref={context} tabIndex={-1}><TaskContext ref={memoryDraft} task={task} token={token} onUpdate={onUpdate} onDirtyChange={setContextDirty} /></div>
    {!!view?.history.length && <details className="burrow-request-details"><summary>Previous versions ({view.history.length})</summary>{view.history.map(([id, result], index) => <details key={id}><summary>Previous version {view.history.length - index}</summary><SavedResearchText text={result} /></details>)}</details>}
    </div>
    <div hidden={tab !== "sources"}><h2>Sources & evidence</h2><p className="burrow-small">{coding ? "Review file changes and test outcomes in the saved coding report. A screenshot is not proof that tests passed." : "Captured pages support this task, not signup or payment eligibility."}</p>{evidence.length ? evidence.map(e => <div className="research-source" key={e.id}><p>{e.url}</p><small>{e.capturedAt} · {coding ? "Saved evidence" : "Regional page only"}</small><button className="burrow-secondary" onClick={() => void showEvidence(e.id!)}>View screenshot</button></div>) : <p className="burrow-small">No captured evidence yet. A finished answer is not proof on its own.</p>}{image && <section className="burrow-request-details"><button className="burrow-secondary" onClick={() => setImage(null)}>Close screenshot</button><p>{image.url}<br />{image.capturedAt} · {coding ? "Saved evidence" : "Regional page only"}</p><img src={image.src} alt={`Saved evidence for ${image.url}`} style={{ maxWidth: "100%" }} /></section>}</div>
    <div hidden={tab !== "activity"}><h2>Activity</h2><p className="burrow-small">{activity}</p>{view?.agent.routing && <details className="burrow-request-details"><summary>Technical details · services used</summary>{modelRoles.map(r => view.agent.routing?.[r] && <div key={r}><h3>{r}</h3><RouteDisclosure route={view.agent.routing[r]} /></div>)}</details>}{view?.agent.usage && <details className="burrow-request-details"><summary>Technical details · costs & usage ({view.agent.usage.length})</summary><p>These cost estimates are not final bills. Missing costs are unknown, not zero. Amounts held against the budget are not necessarily charges.</p>{view.agent.usage.map(u => <div key={u.id}><p>Request {u.id} · {u.status === "complete" ? "Response received" : "Waiting for a response"} · {u.role}<br />{u.canonicalModel} → {u.providerModelId} · connection {u.connectionId} · Funded by {u.fundedBy === "you" ? "you" : "Ohiyo"}<br />Tokens: {(["input", "output", "cacheRead", "cacheWrite"] as const).map(k => `${k}: ${u.usage?.[k] ?? "unavailable"}`).join(" · ")}<br />Estimated cost: {u.reportedCostMicros == null ? "unavailable" : `USD ${(u.reportedCostMicros / 1_000_000).toFixed(6)}`}<br />Held against this budget: USD {(u.reservationMicros / 1_000_000).toFixed(6)}</p></div>)}</details>}<p className="burrow-small">Your reading place is remembered while you use this tab and account. Your saved work stays in Burrow. Opening a task never restarts it.</p></div>
    {coding && view && <div hidden={tab !== "activity"}><RecentCommands key={`${token}:${task.id}:${view.agent.id}`} token={token} taskId={task.id} events={view.events} /></div>}
    </div></section></div>
  </article>;
}
