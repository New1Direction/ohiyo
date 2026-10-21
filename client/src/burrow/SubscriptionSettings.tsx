import { useEffect, useRef, useState } from "react";
import { api, type ModelRouting, type SubscriptionConnection, type SubscriptionConnections, type SubscriptionProvider } from "../api";

const labels: Record<SubscriptionConnection["state"], string> = {
  connected: "Signed in", disconnected: "Not connected", unavailable: "Setup needed",
  awaiting_sign_in: "Waiting for you", verifying: "Checking sign-in…",
  failed: "Sign-in not confirmed", expired: "Sign-in expired",
};
export default function SubscriptionSettings({ token, routing, onRefresh, onDone }: { token: string; routing?: ModelRouting | null; onRefresh?: () => Promise<void>; onDone?: () => void }) {
  const [data, setData] = useState<SubscriptionConnections | null>(null);
  const [selected, setSelected] = useState<SubscriptionProvider | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState("");
  const code = useRef<HTMLInputElement>(null);
  const pending = data && [data.claude, data.chatgpt].some(c => c.state === "awaiting_sign_in" || c.state === "verifying");
  useEffect(() => {
    let active = true;
    void api.subscriptions(token).then(result => { if (active) setData(result); })
      .catch(() => { if (active) setError("Connection status unavailable. Refresh to check; no work was started."); });
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    if (!pending || busy) return;
    let active = true;
    const timer = setTimeout(() => {
      void api.subscriptions(token).then(result => { if (active) { setData(result); setError(""); } })
        .catch(() => { if (active) setError("Couldn’t confirm sign-in. Refresh before trying again."); });
    }, 2500);
    return () => { active = false; clearTimeout(timer); };
  }, [pending, busy, data, token]);
  async function mutate(provider: SubscriptionProvider, action: () => Promise<SubscriptionConnection>) {
    setBusy(true); setError("");
    try { const result = await action(); setData(previous => previous && ({ ...previous, [provider]: result })); }
    catch { setError("Couldn’t confirm the change. Refresh before trying again; do not repeat your sign-in code."); }
    finally { setBusy(false); }
  }
  const connection = selected ? data?.[selected] : null;
  const name = selected === "claude" ? "Claude" : "ChatGPT";
  const models = connection?.models ?? [];
  const selectedModel = models.some(m => m.id === model) ? model : models.find(m => m.providerModelId === (selected === "claude" ? "claude-sonnet-5-5" : "gpt-6-sol"))?.id ?? models[0]?.id ?? "";
  const inUse = !!selectedModel && (["general", "research", "review", "summary"] as const).every(role => routing?.roles[role] === selectedModel);
  return <section className="burrow-subscriptions" aria-label="Subscription connections">
    <div className="burrow-connection-heading"><div><h2>Connections</h2><p className="burrow-small">Your plans. Your accounts. No keys to paste.</p></div>
      <button className="burrow-secondary" aria-expanded={choosing} aria-controls="subscription-picker" onClick={() => { setChoosing(!choosing); setSelected(null); }}>＋ Add connection</button>
    </div>
    <p className="burrow-small">Bring a plan you already have. Connect your account, choose a model, then make your first ask. Current tasks won’t switch accounts.</p>
    {(["chatgpt", "claude"] as const).map(provider => <div className="burrow-connection-row" key={provider}>
      <span className={`burrow-provider-mark ${provider}`} aria-hidden="true">{provider === "claude" ? "✳" : "◎"}</span>
      <div><strong>{provider === "claude" ? "Claude" : "ChatGPT"}</strong><p className="burrow-small">{data?.[provider]?.email ?? (provider === "claude" ? "Your Claude plan" : "Your ChatGPT plan")}</p></div>
      <span className="burrow-connection-state">{data?.[provider] ? labels[data[provider].state] : "Not checked"}</span>
      <button className="burrow-secondary" disabled={busy} onClick={() => { setSelected(provider); setChoosing(false); }}>{data?.[provider]?.state === "connected" ? "Manage" : "Connect"}</button>
    </div>)}
    {choosing && <div id="subscription-picker" className="burrow-connect-panel"><h3>Add a connection</h3><p className="burrow-small">Choose the plan you already have.</p>
      <button className="burrow-secondary" onClick={() => { setSelected("chatgpt"); setChoosing(false); }}>ChatGPT</button>{" "}
      <button className="burrow-secondary" onClick={() => { setSelected("claude"); setChoosing(false); }}>Claude Pro / Max</button>
    </div>}
    {selected && <div className="burrow-connect-panel">
      <div className="burrow-connection-heading"><h3>{selected === "claude" ? "Connect Claude" : "Connect ChatGPT"}</h3><button className="burrow-secondary" onClick={() => setSelected(null)}>Close</button></div>
        <ol className="burrow-connect-steps" aria-label="Connection steps"><li>Sign in with {name}</li><li>Choose your model</li><li>Make yourself at home</li></ol>
        <p>Sign in on {name}’s own page. Burrow never asks for your password, and your account stays separate from everyone else’s.</p>
        <p className="burrow-small">Uses your plan’s allowance and provider account settings. Available models and limits depend on your plan. No automatic switch to paid API keys. Connecting never starts a task.</p>
        {selected === "chatgpt" && <p className="burrow-small">If OpenAI asks, enable device-code login in your ChatGPT security settings, then return here.</p>}
        {connection?.state === "unavailable" && <p>We can’t reach sign-in right now. Refresh connections to check again; your work is still saved.</p>}
        {connection?.state === "connected" ? <>
          <p role="status">Signed in{connection.email ? ` as ${connection.email}` : ""}{connection.plan ? ` · ${connection.plan}` : ""}. {inUse ? "Ready for your next research task." : "Choose what Kikka uses for new research."}</p>
          {connection.usableForResearch && <><label>Model<select value={selectedModel} disabled={busy} onChange={e => { setModel(e.target.value); setNotice(""); }}>{models.map(m => <option key={m.id} value={m.id}>{m.name ?? m.providerModelId}</option>)}</select></label><button className="burrow-primary" disabled={busy || !selectedModel || inUse} onClick={async () => {
            setBusy(true); setError(""); setNotice("");
            try { await api.saveModelRoles(token, { general: selectedModel, research: selectedModel, review: selectedModel, summary: selectedModel }); await onRefresh?.(); setNotice("You’re all set. New research will use this model. Existing tasks keep their approved connection."); }
            catch { setError("Couldn’t confirm your model choice. Refresh connections before trying again."); }
            finally { setBusy(false); }
          }}>{busy ? "Saving your choice…" : inUse ? "Using for new research" : "Use for new research"}</button>{(inUse || notice) && onDone && <button className="burrow-secondary" onClick={onDone}>Make my first ask →</button>}</>}
          {!connection.usableForResearch && <p className="burrow-small">Sign-in is saved, but this connection needs updating before it can handle research. Reconnect to finish setup.</p>}
          <button className="burrow-secondary" disabled={busy} onClick={() => void mutate(selected, () => api.disconnectSubscription(token, selected))}>Disconnect {name}</button>
        </> : connection?.state === "awaiting_sign_in" || connection?.state === "verifying" ? <>
          <p role="status">{labels[connection.state]}. Finish signing in on {selected === "claude" ? "Claude’s" : "OpenAI’s"} page.</p>
          {connection.authorizationUrl && <a className="burrow-primary" href={connection.authorizationUrl} target="_blank" rel="noreferrer noopener">Open {name} sign-in ↗</a>}
          {selected === "chatgpt" && connection.userCode && <p>Enter this one-time code on OpenAI’s page: <code className="burrow-device-code">{connection.userCode}</code>. Keep it private. Sign-in will update here automatically.</p>}
          {selected === "claude" && connection.state === "awaiting_sign_in" && <form onSubmit={event => {
            event.preventDefault(); const value = code.current?.value ?? "";
            if (code.current) code.current.value = "";
            if (connection.attempt) void mutate(selected, () => api.completeClaude(token, connection.attempt!, value));
          }}><label>Sign-in code from Claude (if prompted)<input ref={code} required type="password" autoComplete="off" maxLength={4096} /></label><button className="burrow-secondary" disabled={busy}>Finish sign-in</button></form>}
          <button className="burrow-secondary" disabled={busy} onClick={() => void mutate(selected, () => api.disconnectSubscription(token, selected))}>Cancel sign-in</button>
        </> : <button className="burrow-primary" disabled={busy || !connection || connection.state === "unavailable"} onClick={() => void mutate(selected, () => api.connectSubscription(token, selected))}>{busy ? "Opening sign-in…" : `Continue with ${name}`}</button>}
    </div>}
    {notice && <p role="status" className="burrow-connection-success">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <button className="burrow-secondary" disabled={busy} onClick={async () => { setBusy(true); try { setData(await api.subscriptions(token)); setError(""); } catch { setError("Connection status unavailable. Your last known status is shown."); } finally { setBusy(false); } }}>Refresh connections</button>
  </section>;
}
