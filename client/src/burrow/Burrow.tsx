import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, getApiBase, type BurrowTask, type BurrowWorkspace } from "../api";
import { apiStatus } from "../lib/apiErrors";
import { isTwoFactorChallenge } from "../lib/twoFactor";
import Tracker from "./Tracker";
import Everyday from "./Everyday";
import KikkaReply from "./KikkaReply";
import Creation from "./Creation";
import ResearchTask from "./ResearchTask";
import Travel from "./Travel";
import ModelSettings from "./ModelSettings";
import SelectionActions from "./SelectionActions";
import Backdrop from "./Backdrop";
import { submitPromptOnEnter } from "./promptKeys";
import { taskActionError } from "./taskLanguage";
import type { ModelRouting } from "../api";
import kikka from "../../../brand/kikka-chinchilla-clean.png";
import "../index.css";
import "./burrow.css";

const labels: Record<BurrowTask["state"], string> = {
  working: "Working", waiting: "Waiting for you", draft_ready: "Draft ready", failed: "Needs attention",
};
const groups: BurrowTask["state"][] = ["working", "waiting", "draft_ready", "failed"];
function mergeTasks(current: BurrowTask[], incoming: BurrowTask[]) {
  const tasks = new Map(current.map(t => [t.id, t]));
  for (const task of incoming) {
    if (!tasks.has(task.id) || tasks.get(task.id)!.version <= task.version) tasks.set(task.id, task);
  }
  return [...tasks.values()].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
}
// A separate, tab-scoped login: Burrow never loads Ohiyo's conversations or key vault.
const sessionKey = `burrow:session:${getApiBase()}`;
const message = (e: unknown) => taskActionError(e, "Couldn’t confirm the change. Your unsaved text is still here; refresh before trying again.");

export default function Burrow() {
  const [token, setToken] = useState(() => sessionStorage.getItem(sessionKey));
  useEffect(() => { document.title = "Burrow · Kikka"; }, []);
  function signIn(next: string) { sessionStorage.setItem(sessionKey, next); setToken(next); }
  function signOut() { sessionStorage.removeItem(sessionKey); setToken(null); }
  return <div className="burrow">{token ? <Workspace key={token} token={token} onSignOut={signOut} /> : <SignIn onAuth={signIn} />}</div>;
}

function SignIn({ onAuth }: { onAuth: (token: string) => void }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const answer = challenge ? await api.loginTwoFactor(challenge, code) : register ? await api.register(username, password) : await api.login(username, password);
      if (isTwoFactorChallenge(answer)) { setChallenge(answer.challenge); return; }
      onAuth(answer.token);
    } catch (e) { setError(apiStatus(e) === 401 ? "Those sign-in details weren’t accepted. Check them and try again." : apiStatus(e) === 400 ? "Check your details. Use a username of 3–32 characters and a password of at least 8 characters when creating an account." : apiStatus(e) === 409 ? "That username is already taken. Choose another or sign in to your existing account." : message(e)); } finally { setBusy(false); }
  }
  return <main className="burrow-door">
    <a className="burrow-wordmark" href="/">burrow<span>by Ohiyo</span></a>
    <div className="burrow-intro"><img src={kikka} alt="Kikka, your chinchilla Helper" /><p className="burrow-eyebrow">A LITTLE HELP. A LOT OF POSSIBILITY.</p>
      <h1>Good things start<br />with a little ask.</h1><p>Meet Kikka. A place for your plans, your drafts,<br />and the things you want to move forward.</p></div>
    <form className="burrow-login" onSubmit={submit}>
      <span className="burrow-tag">EARLY ACCESS</span><h2>{challenge ? "One more step" : register ? "Make yourself at home." : "Welcome to the Burrow."}</h2>
      <p>{challenge ? "Enter your sign-in code or a recovery code." : "Sign in with your Ohiyo account, or create one below."}</p>
      {challenge ? <label>Sign-in code<input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required /></label> : <>
        <label>Username<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" minLength={3} maxLength={32} required /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={register ? "new-password" : "current-password"} minLength={register ? 8 : 1} required /></label>
      </>}
      {error && <p role="alert" className="burrow-error">{error}</p>}
      <button className="burrow-primary" disabled={busy}>{busy ? "Opening…" : challenge ? "Verify and enter" : register ? "Create account" : "Enter the Burrow"}<span aria-hidden>↗</span></button>
      <button type="button" className="burrow-link" disabled={busy} onClick={() => { setRegister(!register); setChallenge(null); setError(""); }}>{challenge ? "Back to sign in" : register ? "Already have an account? Sign in" : "New here? Create an account"}</button>
      <p className="burrow-small">Burrow is an optional experiment. It does not read your Ohiyo chats. Requests and results are stored on this server, not end-to-end encrypted.</p>
    </form>
  </main>;
}

function Workspace({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [data, setData] = useState<BurrowWorkspace | null>(null);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("task"));
  const [request, setRequest] = useState("");
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [ambiencePaused, setAmbiencePaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [travelGoal, setTravelGoal] = useState<string | null>(null);
  const [routing, setRouting] = useState<ModelRouting | null>(null);
  async function refreshRouting() { setRouting(await api.modelRouting(token)); }
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set("task", selected); else url.searchParams.delete("task");
    window.history.replaceState(null, "", url);
  }, [selected]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.burrow(token);
        if (alive) { setData(old => ({ ...next, tasks: mergeTasks(old?.tasks ?? [], next.tasks) })); setRefreshError(""); }
      } catch (e) {
        if (alive) {
          if (apiStatus(e) === 401) { onSignOut(); return; }
          setRefreshError("Couldn't refresh your tasks. Displayed statuses may be out of date. Retrying…");
        }
      }
      if (alive) timer = setTimeout(refresh, 2000);
    }
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
    // The session is fixed for this mounted workspace; polling must not restart on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  function update(task: BurrowTask) {
    setData(old => old && ({ ...old, tasks: mergeTasks(old.tasks, [task]) }));
  }
  async function create(e: FormEvent) {
    e.preventDefault(); await createRequest(request);
  }
  async function research() {
    if (!request.trim() || busy) return;
    setBusy(true); setError("");
    try { const task = await api.createBurrowTask(token, request, "writing", undefined, { project: project.trim() || undefined, comparison: true }); update(task); setSelected(task.id); setRequest(""); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function createRequest(text: string, example?: "quiz" | "story" | "page") {
    if (!text.trim() || busy || !data) return;
    setBusy(true); setError("");
    try { const task = await api.createBurrowPage(token, text, example); update(task); setSelected(task.id); setNavOpen(false); if (text === request) setRequest(""); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const task = data?.tasks.find(t => t.id === selected);
  const active = data?.tasks.filter(t => t.state === "working").length ?? 0;
  const filtered = data?.tasks.filter(t => t.request.toLowerCase().includes(search.toLowerCase())) ?? [];
  function selectTask(id: string | null) {
    if (id === selected && travelGoal === null) return;
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setTravelGoal(null);
    setSelected(id); setError(""); setNavOpen(false);
    if (id === null) requestAnimationFrame(() => input.current?.focus());
  }
  function newTask() { selectTask(null); }
  return <div className="burrow-shell">
    <aside className={`burrow-sidebar ${navOpen ? "mobile-open" : ""}`}>
      <a className="burrow-wordmark" href="/burrow">burrow<span>EARLY ACCESS</span></a>
      <button className="burrow-secondary burrow-mobile-nav" aria-expanded={navOpen} aria-controls="burrow-saved" onClick={() => setNavOpen(!navOpen)}>Saved</button>
      <div className="burrow-kikka"><img src={kikka} alt="" /><div><strong>Kikka</strong><span><i />{active ? `Working on ${active} ${active === 1 ? "task" : "tasks"}` : "Your Helper"}</span></div></div>
      <button className="burrow-primary" onClick={newTask}><span aria-hidden>＋</span> New creation</button>
      <label className="burrow-search"><span className="sr-only">Find something saved</span><input placeholder="Find something saved…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <nav id="burrow-saved" aria-label="Your tasks" className="burrow-task-list">
        {!data && <p className="burrow-small">Loading your workspace…</p>}
        {data && data.tasks.length === 0 && <div className="burrow-empty-list"><span aria-hidden>✳</span><p>A little room for<br />your next big thing.</p><small>Your tasks will live here.</small></div>}
        {data && data.tasks.length > 0 && filtered.length === 0 && <p className="burrow-small">No matching tasks.</p>}
        {groups.map(state => {
          const tasks = filtered.filter(t => t.state === state);
          return tasks.length > 0 && <section key={state} className="burrow-group"><h2>{state === "draft_ready" ? "Saved for you" : labels[state]}<span>{tasks.length}</span></h2>
            {tasks.map(t => <button key={t.id} className={`burrow-task ${t.id === selected ? "selected" : ""}`} aria-current={t.id === selected ? "page" : undefined} onClick={() => selectTask(t.id)}><i className={`burrow-dot ${t.state}`} /><span>{t.request}</span><span aria-hidden>↗</span></button>)}
          </section>;
        })}
      </nav>
      <footer><span>Private chats stay in Ohiyo.</span><div><a href="/">Open Ohiyo ↗</a><button className="burrow-link" onClick={() => { if (!dirty || window.confirm("Discard your unsaved draft edits and sign out?")) onSignOut(); }}>Sign out</button></div></footer>
    </aside>
    <main className={`burrow-main${ambiencePaused ? " ambience-paused" : ""}`}>
      <header className="burrow-topbar"><span>Kikka’s corner <span aria-hidden>/</span> {task?.format === "creation" ? "Your creation" : task?.template === "bill" ? "Your shared bill" : task?.template === "packing" ? "Your next trip" : task?.kind === "tracker" ? "Your launch" : task ? "Your request" : "A fresh start"}</span><div className="burrow-routing-actions"><Backdrop paused={ambiencePaused} resting={!!task || travelGoal !== null} /><button className="burrow-link burrow-motion-control" aria-pressed={ambiencePaused} aria-label="Pause background motion" onClick={() => setAmbiencePaused(!ambiencePaused)}><span aria-hidden="true">{ambiencePaused ? "Ⅱ" : "~"}</span> Motion</button><button className="burrow-link" aria-expanded={settingsOpen} aria-controls="model-settings" onClick={() => { setSettingsOpen(!settingsOpen); if (!settingsOpen) void refreshRouting().catch(() => setRouting(null)); }}>Connections {settingsOpen ? "−" : "+"}</button><span className="burrow-tag">EARLY ACCESS</span></div></header>
      {settingsOpen && <ModelSettings key={routing ? "loaded" : "unavailable"} token={token} data={routing} onRefresh={refreshRouting} onDone={() => { setSettingsOpen(false); selectTask(null); }} />}
      {refreshError && <p role="alert" className="burrow-error burrow-refresh-error">{refreshError}</p>}
      {error && <p role="alert" className="burrow-error burrow-refresh-error">{error}</p>}
      {travelGoal !== null ? <Travel token={token} goal={travelGoal} onDirtyChange={setDirty} onCancel={() => { if (window.confirm("Discard this trip draft?")) setTravelGoal(null); }} onCreated={next => { update(next); setSelected(next.id); setTravelGoal(null); setRequest(""); }} /> : task?.format === "creation" ? <Creation key={task.id} task={task} token={token} canRun={data?.can_run ?? false} service={data?.service ?? null} onUpdate={update} onDirtyChange={setDirty} /> : task?.template ? <Everyday key={task.id} task={task} token={token} onUpdate={update} onDirtyChange={setDirty} /> : task?.kind === "tracker" ? <Tracker key={task.id} task={task} token={token} onUpdate={next => { update(next); if (next.id !== task.id) setSelected(next.id); }} onDirtyChange={setDirty} /> : task && (task.travel || data?.agent_task_ids?.includes(task.id) || (data?.can_research && !task.result)) ? <ResearchTask key={task.id} task={task} token={token} canRun={data?.can_research ?? false} onUpdate={update} onDirtyChange={setDirty} /> : task ? <TaskView key={task.id} task={task} token={token} canRun={data?.can_run ?? false} service={data?.service ?? null} onUpdate={update} onDirtyChange={setDirty} /> : <div className="burrow-welcome">
        <div className="burrow-hello"><div className="burrow-mascot"><img src={kikka} alt="Kikka, ready to help" /><span aria-hidden>✳</span></div>
          <p className="burrow-eyebrow">HEY, I’M KIKKA.</p><h1>What if you could just make it?</h1><p>Your notes, turned into something you can play.<br />An idea, turned into a page you can actually use.</p></div>
        <form onSubmit={create} className="burrow-composer"><label className="sr-only" htmlFor="burrow-request">New task for Kikka</label><textarea id="burrow-request" ref={input} value={request} onChange={e => setRequest(e.target.value)} onKeyDown={submitPromptOnEnter} aria-describedby="burrow-send-hint" placeholder="Kikka, can you help me with…" maxLength={8000} required rows={3} />
          <div><span id="burrow-send-hint">Enter to send · Shift+Enter for a new line</span><button type="submit" className="burrow-primary" disabled={busy || !data || !request.trim()}>{busy ? "Saving…" : "Continue"}<span aria-hidden>↑</span></button></div>
          {data?.can_research && <section className="burrow-research-start"><label>Project (optional)<input maxLength={80} value={project} onChange={e => setProject(e.target.value)} placeholder="Cotton suppliers" /></label><button type="button" className="burrow-secondary" disabled={busy || !request.trim()} onClick={() => void research()}>Research public pages</button></section>}
          {data?.can_travel === true && <section className="burrow-research-start"><button type="button" className="burrow-secondary" disabled={busy || !request.trim()} onClick={() => setTravelGoal(request)}>Plan a trip</button><span>Fixture demo — no real booking</span></section>}
        </form>
        <div className="burrow-creation-examples"><div className="burrow-example-heading"><h2>A few things you can play with</h2><span>READY-MADE EXAMPLES</span></div><div className="burrow-example-grid">
          <button disabled={busy || !data} onClick={() => void createRequest("Turn my notes into a study space", "quiz")}><span className="burrow-example-art study" aria-hidden="true"><b>A B C</b><i /><i /><i /></span><strong>Make it stick</strong><p>Notes become a quiz.<br />Find out what you actually know.</p><small>Try study example →</small></button>
          <button disabled={busy || !data} onClick={() => void createRequest("Make a story where I choose what happens", "story")}><span className="burrow-example-art story" aria-hidden="true"><b>☾</b><i>← YOUR CHOICE →</i></span><strong>Choose what happens</strong><p>A story you don’t just read.<br />You decide how it ends.</p><small>Try story example →</small></button>
          <button disabled={busy || !data} onClick={() => void createRequest("Make a birthday page that feels like me", "page")}><span className="burrow-example-art invite" aria-hidden="true"><b>you’re invited.</b><i>✦ &nbsp; ✦ &nbsp; ✦</i></span><strong>Make it your own</strong><p>A birthday. A big idea.<br />A little page with personality.</p><small>Try page example →</small></button>
        </div></div>
        <p className="burrow-small burrow-disclosure">{data?.can_run ? "Your request stays private until you choose Make it. No accounts to connect." : "Examples work now. Personal creation isn’t connected on this server yet; your requests stay saved."}</p>
      </div>}
    </main>
  </div>;
}

function TaskView({ task, token, canRun, service, onUpdate, onDirtyChange }: { task: BurrowTask; token: string; canRun: boolean; service: string | null; onUpdate: (t: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void }) {
  const selectionRoot = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ text: string; version: number } | null>(null);
  const [saved, setSaved] = useState(false);
  useLayoutEffect(() => {
    onDirtyChange(!!editor && editor.text !== task.result);
    return () => onDirtyChange(false);
  }, [editor, task.result, onDirtyChange]);
  useEffect(() => {
    if (!editor || editor.text === task.result) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editor, task.result]);
  async function run() {
    if (busy) return;
    setBusy(true); setError("");
    try { onUpdate(await api.runBurrowTask(token, task.id)); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (!editor || busy) return;
    setBusy(true); setError("");
    try { onUpdate(await api.saveBurrowResult(token, { ...task, version: editor.version }, editor.text)); setEditor(null); setSaved(true); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <article ref={selectionRoot} className="burrow-detail">
    <SelectionActions root={selectionRoot} />
    <div className="burrow-detail-heading"><span className={`burrow-status ${task.state}`}><i className={`burrow-dot ${task.state}`} />{labels[task.state]}</span><span className="burrow-small">Saved {new Date(task.created_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>
    <h1>{task.request.length > 90 ? `${task.request.slice(0, 90)}…` : task.request}</h1>
    <details className="burrow-request-details"><summary>Your request</summary><p>{task.request}</p></details>
    <KikkaReply revision={task.version} activity={busy || task.state === "working" ? "working" : error || (editor && editor.text !== task.result) ? "needs-you" : task.state === "draft_ready" ? "ready" : "needs-you"} text={busy ? "One moment…" : error || (task.state === "working" ? "I'm writing your draft. You can start something else or come back later." : editor && editor.text !== task.result ? "Your edits are here. Save them when you’re ready." : task.state === "draft_ready" ? "Here’s a first draft. You can edit it below." : task.state === "failed" ? "I couldn’t finish this one. Nothing was sent or published on your behalf." : canRun ? "I can help put this into words. Just need your okay first." : "I’ve saved your request. I can’t start it yet.")} />
    {task.error && <p className="burrow-error" role="status">Kikka couldn’t finish this draft. Your saved work is still here. A previous attempt may already have cost money.</p>}
    {(task.state === "waiting" || task.state === "failed") && <section className="burrow-permission"><p className="burrow-eyebrow">YOUR CALL</p><h2>{canRun ? "Can I get started?" : "Kikka isn’t ready to work here yet."}</h2>
      {canRun ? <><p>To write this draft, I’ll share this request with <strong>{service}</strong>. Not your Ohiyo chats or other tasks. This may cost money{task.state === "failed" ? ", even if the previous try was charged" : ""}.</p>
        <button className="burrow-primary" onClick={run} disabled={busy}>{busy ? "Starting…" : task.state === "failed" ? "Allow & try again" : "Allow & start"}<span aria-hidden>↗</span></button></> : <p>Your request is saved, but I’m not working on it. The person running this Burrow needs to enable writing first.</p>}
    </section>}
    {task.state === "working" && <div className="burrow-working" role="status"><i className="burrow-dot working" />Writing your draft…<span>Feel free to start something else.</span></div>}
    <div data-selection-content>
    {task.state === "draft_ready" && <section className="burrow-result"><header><div><p className="burrow-eyebrow">SAVED FOR YOU</p><h2>Your draft</h2></div>{!editor && <button className="burrow-secondary" onClick={() => { setEditor({ text: task.result, version: task.version }); setSaved(false); }}>Edit</button>}</header>
      {editor ? <><label className="sr-only" htmlFor="burrow-result">Edit saved draft</label><textarea id="burrow-result" value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} /><div className="burrow-editor-actions"><span className="burrow-small">{editor.version !== task.version ? "A newer version exists. Copy your changes before reopening." : "Changes are not saved until you save."}</span><button className="burrow-secondary" disabled={busy} onClick={() => { setEditor(null); setError(""); }}>Discard edits</button><button className="burrow-primary" disabled={busy || !editor.text.trim()} onClick={save}>{busy ? "Saving…" : "Save changes"}</button></div></> : <div className="burrow-document">{task.result}</div>}
      <footer><span>Check the facts before using this draft.</span><span role="status">{saved ? "Changes saved" : "Saved"}</span></footer>
    </section>}
    </div>
    {error && <p role="alert" className="burrow-error">{error}</p>}
    <p className="burrow-small">Only planning and writing are available in this pilot. Requests and results are stored on this server, not end-to-end encrypted.</p>
  </article>;
}
