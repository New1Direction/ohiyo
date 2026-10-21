import { useEffect, useRef, useState } from "react";
import { api, type ModelConnection, type ModelConnectionInput, type ModelRoute, type ModelRouting } from "../api";
import SubscriptionSettings from "./SubscriptionSettings";

export const modelRoles = ["general", "research", "review", "summary"] as const;
export function RouteDisclosure({ route }: { route: ModelRoute }) {
  if (route.connectionId.startsWith("subscription-")) return <p className="burrow-small">{route.providerModelId} · Your connected {route.connectionId === "subscription-claude" ? "Claude" : "ChatGPT"} plan<br />Up to 20 requests per task, including follow-ups and summaries. Your provider’s allowance and billing settings apply; remaining allowance and charges are unavailable here. This is not a dollar or output-token cap. No paid API fallback.</p>;
  return <p className="burrow-small">{route.canonicalModel} → {route.providerModelId} · connection {route.connectionId} · Funded by {route.fundedBy === "you" ? "you" : "Ohiyo"}<br />Endpoint: {route.endpoint}<br />Context: {route.contextWindow.toLocaleString()} tokens · Maximum output: {route.maxOutputTokens.toLocaleString()} tokens<br />Catalog USD / million tokens: input {route.inputUsdPerMillion ?? "unavailable"}, output {route.outputUsdPerMillion ?? "unavailable"}. Estimates, not an invoice.</p>;
}

export default function ModelSettings({ token, data, onRefresh, onDone }: { token: string; data: ModelRouting | null; onRefresh: () => Promise<void>; onDone?: () => void }) {
  const [roles, setRoles] = useState(data?.roles ?? {});
  const [editing, setEditing] = useState<ModelConnectionInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setRoles(data?.roles ?? {}); }, [data]);
  const templates = data?.connections.filter(c => c.scope === "ohiyo") ?? [];
  const personal = data?.connections.filter(c => c.scope === "personal").sort((a, b) => a.priority - b.priority) ?? [];
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); setNotice("");
    try { await action(); await onRefresh(); setEditing(null); setNotice("Settings saved. New tasks use these settings; existing tasks keep their approved service."); }
    catch { setNotice("Couldn’t confirm the update. Refresh settings before retrying. No task or service test was started."); }
    finally { if (keyInput.current) keyInput.current.value = ""; setBusy(false); }
  }
  function edit(c: ModelConnection) {
    if (keyInput.current) keyInput.current.value = "";
    setEditing({ id: c.id, name: c.name, templateId: c.templateId, modelMapping: c.modelMapping, active: c.active, priority: c.priority });
  }
  return <section id="model-settings" className="burrow-permission" aria-label="Connection settings">
    <SubscriptionSettings key={token} token={token} routing={data} onRefresh={onRefresh} onDone={onDone} />
    <details className="burrow-request-details"><summary>Advanced · API keys and model routing</summary>
    <h2>Model routing · optional advanced settings</h2>
    <p>With an Ohiyo-funded default, you don’t need your own key. These settings do not grant task approval or change your spending cap. Private Ohiyo chats stay separate.</p>
    <p>Roles choose catalog models. Active personal connections are considered in priority order, then Ohiyo connections. This is route selection, not automatic fallback after a provider failure. Saved routes stay pinned; changing or revoking a connection can pause existing work.</p>
    {!data ? <p>Routing settings unavailable.</p> : <>
      {data.disabledReason && <p role="status">Kikka’s connection isn’t set up here yet. The person running Burrow needs to finish setup.</p>}
      {!!data.catalog.length && <form onSubmit={e => { e.preventDefault(); void mutate(() => api.saveModelRoles(token, roles)); }}>
        <div className="burrow-role-grid">{modelRoles.map(role => <div key={role}><label>{role}<select disabled={busy} value={roles[role] ?? ""} required onChange={e => setRoles({ ...roles, [role]: e.target.value })}><option value="" disabled>Choose a catalog model</option>{data.catalog.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label>{data.preview[role] ? <RouteDisclosure route={data.preview[role]} /> : <p className="burrow-small">No resolved route. Funding unavailable.</p>}</div>)}</div>
        <button className="burrow-secondary" disabled={busy}>Save role models</button>
        <p className="burrow-small">Previews show saved settings, not unsaved selections.</p>
      </form>}
      <h3>Personal connections · funded by you</h3>
      <p>Use your own API key with a connection approved for this Burrow. Saved keys are never shown again; leave the field blank to keep your current key. These connections are separate from subscriptions. Saving does not test the service.</p>
      {personal.length === 0 && <p>No personal connections saved.</p>}
      {personal.map(c => <div key={c.id}><p>{c.priority}: {c.name} · {c.active ? "Active" : "Inactive"} · {c.hasKey ? "Key saved" : "No key"} · Template {c.templateId}</p><button className="burrow-secondary" disabled={busy} onClick={() => edit(c)}>Edit {c.name}</button> <button className="burrow-secondary" disabled={busy} onClick={() => { if (window.confirm(`Delete ${c.name}? Saved tasks keep their pinned route.`)) void mutate(() => api.deleteModelConnection(token, c.id)); }}>Delete</button></div>)}
      <button className="burrow-secondary" disabled={busy || !templates.length} onClick={() => { if (keyInput.current) keyInput.current.value = ""; setEditing({ name: "", templateId: templates[0].id, modelMapping: templates[0].modelMapping, active: false, priority: personal.length }); }}>Add personal connection</button>
      {!templates.length && <p>No approved connections are available to add here yet.</p>}
      {editing && <form onSubmit={e => {
        e.preventDefault();
        const key = keyInput.current?.value;
        if (keyInput.current) keyInput.current.value = "";
        void mutate(() => api.saveModelConnection(token, { ...editing, ...(key ? { key } : {}) }));
      }}>
        <label>Name<input required maxLength={200} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
        <label>Approved template<select required value={editing.templateId} onChange={e => setEditing({ ...editing, templateId: e.target.value })}>{templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}</select></label>
        <label>Model mapping<textarea rows={4} maxLength={16000} value={editing.modelMapping} onChange={e => setEditing({ ...editing, modelMapping: e.target.value })} /></label>
        <p className="burrow-small">One rule per line: * includes all, -model excludes, canonical-model → provider-model aliases (use ASCII -&gt;). Wildcards match model names; the last matching rule wins. Unmatched models are excluded. Blank uses the approved template’s mapping.</p>
        <p className="burrow-small">Alias targets need reviewed catalog pricing or an operator-approved template alias. Unknown targets are rejected; known targets use their own limits and rates.</p>
        <label>Priority (lower first)<input type="number" min={0} step={1} required value={editing.priority} onChange={e => setEditing({ ...editing, priority: Number(e.target.value) })} /></label>
        <label><input type="checkbox" checked={editing.active} onChange={e => setEditing({ ...editing, active: e.target.checked })} />Active</label>
        <label>API key (write-only)<input ref={keyInput} type="password" autoComplete="off" name="burrow-provider-key" /></label>
        <button className="burrow-primary" disabled={busy || !Number.isInteger(editing.priority) || editing.priority < 0}>Save connection</button> <button type="button" className="burrow-secondary" disabled={busy} onClick={() => { if (keyInput.current) keyInput.current.value = ""; setEditing(null); }}>Cancel</button>
      </form>}
      <details className="burrow-request-details"><summary>Ohiyo connections / approved templates</summary>{templates.map(t => <p key={t.id}>{t.priority}: {t.name} ({t.id}) · {t.active ? "Active" : "Inactive"} · {t.hasKey ? "Operator key saved" : "No operator key"}<br />{t.modelMapping}</p>)}</details>
    </>}
    <p className="burrow-small">Usage and costs may be unavailable. Estimates are not final bills, and amounts held against your budget are not necessarily charges. Saving settings does not start a task or test the service.</p>
    <button className="burrow-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); setNotice("Settings refreshed."); } catch { setNotice("Routing settings unavailable. Try again later."); } finally { setBusy(false); } }}>Refresh settings</button>
    {notice && <p role="status">{notice}</p>}
    </details>
  </section>;
}
