import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type BillPage, type BurrowTask, type EverydayResult, type PackingPage } from "../api";
import KikkaReply from "./KikkaReply";
import { taskActionError } from "./taskLanguage";
import "./everyday.css";

export default function Everyday({ task, token, onUpdate, onDirtyChange }: { task: BurrowTask; token: string; onUpdate: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void }) {
  const result: EverydayResult = JSON.parse(task.result);
  const [draft, setDraft] = useState<BillPage | PackingPage | null>(null);
  const [version, setVersion] = useState(task.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const sending = useRef(false);
  const page = draft ?? result.page;
  const dirty = draft !== null;
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function edit(next: BillPage | PackingPage) {
    if (!draft) setVersion(task.version);
    setDraft(next); setError(""); setCopied(false);
  }
  async function save() {
    if (!draft || sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try { onUpdate(await api.saveBurrowResult(token, { ...task, version }, JSON.stringify(draft))); setDraft(null); }
    catch (e) { setError(taskActionError(e, "Couldn’t confirm your save. Your changes are still here; refresh before trying again.")); }
    finally { sending.current = false; setBusy(false); }
  }
  const money = (cents: number) => new Intl.NumberFormat("en", { style: "currency", currency: page.type === "bill" ? page.currency : "USD" }).format(cents / 100);
  const savedBill = result.page.type === "bill" ? result as Extract<EverydayResult, { page: BillPage }> : null;
  const name = (id: string) => page.type === "bill" ? page.people.find(p => p.id === id)?.name ?? "Someone" : "";
  async function copySplit() {
    if (!savedBill || dirty) return;
    try {
      const lines = savedBill.summary.payments.map(p => `${name(p.from)} → ${name(p.to)}: ${money(p.cents)}`);
      await navigator.clipboard.writeText(`${page.title}\nTotal: ${money(savedBill.summary.total_cents)}\n${lines.length ? lines.join("\n") : "Everyone is even."}\nSuggested payments only; no money has been moved.`);
      setCopied(true); setError("");
    } catch { setError("Couldn’t copy that. You can still read the split below."); }
  }
  const settingsChanged = page.type === "packing" && result.page.type === "packing" && (page.nights !== result.page.nights || page.weather !== result.page.weather || JSON.stringify(page.activities) !== JSON.stringify(result.page.activities));
  const packed = page.type === "packing" ? page.items.filter(i => i.packed).length : 0;
  const reply = busy ? "Saving this for you…" : error || (dirty ? page.type === "bill" ? "Add what everyone paid. I’ll work out the split when you’re ready." : "Save your changes so your list is here when you come back." : page.type === "bill" ? "Dinner, a weekend away, or the weekly shop. Add who paid and who shared each cost—I’ll handle the maths." : "A little less ‘did I forget something?’ Change your trip details and I’ll update your list. Your own extras stay put.");
  return <article className="everyday-workspace">
    <header className="everyday-heading"><div><p className="burrow-eyebrow">{page.type === "bill" ? "GOOD TIMES. NO AWKWARD MATHS." : "LESS TO REMEMBER. MORE TO LOOK FORWARD TO."}</p><h1>{page.type === "bill" ? "Split it. Stay friends." : "A little less to forget."}</h1><p>{page.type === "bill" ? "Who paid? Who was there? We’ll take it from here." : "Tell us a little about your trip. We’ll help with the packing."}</p></div><span role="status" className="burrow-tag">{busy ? "SAVING…" : dirty ? "NOT SAVED YET" : "SAVED FOR YOU"}</span></header>
    <div className="everyday-layout"><form className="everyday-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <label className="everyday-title">{page.type === "bill" ? "What’s this for?" : "Where are you off to?"}<input value={page.title} maxLength={200} required onChange={e => edit({ ...page, title: e.target.value })} placeholder={page.type === "bill" ? "Friday night dinner" : "A weekend in Lisbon"} /></label>
        {page.type === "bill" ? <>
          <section className="everyday-section"><div className="everyday-section-heading"><h2>Who’s in?</h2><button type="button" className="burrow-link" disabled={page.people.length >= 12} onClick={() => edit({ ...page, people: [...page.people, { id: crypto.randomUUID(), name: `Friend ${page.people.length}` }] })}>＋ Add someone</button></div>
            <div className="everyday-people">{page.people.map((person, index) => <div key={person.id}><span className="everyday-person-number" aria-hidden="true">{index + 1}</span><label><span className="sr-only">Person {index + 1}</span><input value={person.name} maxLength={80} required onChange={e => edit({ ...page, people: page.people.map(p => p.id === person.id ? { ...p, name: e.target.value } : p) })} /></label><button type="button" className="burrow-link" aria-label={`Remove person ${index + 1}`} disabled={page.people.length <= 2 || page.expenses.some(e => e.paid_by === person.id || e.shared_by.includes(person.id))} title="Remove their expenses first; keep at least two people." onClick={() => edit({ ...page, people: page.people.filter(p => p.id !== person.id) })}>×</button></div>)}</div>
            <p className="burrow-small">Names only. Nobody is invited or contacted.</p>
          </section>
          <section className="everyday-section"><div className="everyday-section-heading"><h2>What did you pay for?</h2><label className="everyday-currency"><span className="sr-only">Currency</span><select value={page.currency} onChange={e => edit({ ...page, currency: e.target.value as BillPage["currency"] })}><option value="USD">USD $</option><option value="EUR">EUR €</option><option value="GBP">GBP £</option></select></label></div>
            <p className="burrow-small">Use one currency for all costs. Changing the label doesn’t convert amounts.</p>
            {page.expenses.length === 0 && <div className="everyday-empty"><span aria-hidden="true">↗</span><p>Dinner? Tickets? That taxi home?</p><small>Add the first cost to get started.</small></div>}
            {page.expenses.map((expense, index) => <div className="everyday-expense" key={expense.id}>
              <div className="everyday-expense-fields"><label>What was it?<input aria-label={`Expense ${index + 1}`} value={expense.title} required maxLength={200} placeholder="Dinner" onChange={e => edit({ ...page, expenses: page.expenses.map(x => x.id === expense.id ? { ...x, title: e.target.value } : x) })} /></label><label>How much?<input aria-label={`Amount ${index + 1}`} inputMode="decimal" value={expense.amount} required pattern="[0-9]+([.][0-9]{1,2})?" placeholder="0.00" onChange={e => edit({ ...page, expenses: page.expenses.map(x => x.id === expense.id ? { ...x, amount: e.target.value } : x) })} /></label><label>Paid by<select aria-label={`Paid by for expense ${index + 1}`} value={expense.paid_by} onChange={e => edit({ ...page, expenses: page.expenses.map(x => x.id === expense.id ? { ...x, paid_by: e.target.value } : x) })}>{page.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
              <div className="everyday-sharing"><span>Split equally between</span>{page.people.map(person => <label key={person.id}><input type="checkbox" aria-label={`Include ${person.name} in expense ${index + 1}`} checked={expense.shared_by.includes(person.id)} onChange={e => edit({ ...page, expenses: page.expenses.map(x => x.id === expense.id ? { ...x, shared_by: e.target.checked ? [...x.shared_by, person.id] : x.shared_by.filter(id => id !== person.id) } : x) })} />{person.name}</label>)}<button type="button" className="burrow-link" aria-label={`Remove expense ${index + 1}`} onClick={() => edit({ ...page, expenses: page.expenses.filter(x => x.id !== expense.id) })}>Remove</button></div>
            </div>)}
            <button type="button" className="everyday-add" disabled={page.expenses.length >= 50} onClick={() => edit({ ...page, expenses: [...page.expenses, { id: crypto.randomUUID(), title: "", amount: "", paid_by: page.people[0].id, shared_by: page.people.map(p => p.id) }] })}>＋ Add a cost</button>
          </section>
        </> : <>
          <section className="everyday-section"><div className="everyday-trip"><label>Nights away<input type="number" min={1} max={30} required value={page.nights} onChange={e => edit({ ...page, nights: Number(e.target.value) })} /></label><label>Weather you’re packing for<select value={page.weather} onChange={e => edit({ ...page, weather: e.target.value as PackingPage["weather"] })}><option value="mixed">A bit of everything</option><option value="warm">Warm & sunny</option><option value="cold">Cold</option></select></label></div><p className="burrow-small">You choose the weather—this isn’t a live forecast.</p>
            <p className="everyday-field-label">Anything on the itinerary?</p><div className="everyday-activities">{[["swimming","Swimming"],["walking","Lots of walking"],["going_out","Going out"],["abroad","Going abroad"]].map(([id,label]) => <label key={id}><input type="checkbox" checked={page.activities.includes(id)} onChange={e => edit({ ...page, activities: e.target.checked ? [...page.activities,id] : page.activities.filter(a => a !== id) })} />{label}</label>)}</div>
          </section>
          <section className="everyday-section"><div className="everyday-section-heading"><h2>Your packing list</h2><span className="burrow-small">{packed} / {page.items.length} packed{dirty ? " · not saved" : ""}</span></div><progress max={page.items.length || 1} value={packed} aria-label="Packing progress" />
            {settingsChanged && <p className="everyday-notice">Your trip changed. Save below to update this list. Items that need a different quantity will be unchecked.</p>}
            <p className="burrow-small">A starting list, not a guarantee. Clothes cap at seven days; plan laundry for longer trips. Check your own travel requirements.</p>
            <div className="everyday-packing">{page.items.map(item => <div className={item.packed ? "packed" : ""} key={item.id}><label className="everyday-pack-check"><input type="checkbox" checked={item.packed} aria-label={`Pack ${item.title}`} onChange={e => edit({ ...page, items: page.items.map(i => i.id === item.id ? { ...i, packed: e.target.checked } : i) })} />{item.custom ? <span className="sr-only">Packed</span> : <span>{item.title}</span>}</label>{item.custom && <input aria-label="Personal item" required maxLength={200} value={item.title} onChange={e => edit({ ...page, items: page.items.map(i => i.id === item.id ? { ...i, title: e.target.value } : i) })} />}<span className="everyday-quantity">× {item.quantity}</span>{item.custom && <button type="button" className="burrow-link" aria-label={`Remove ${item.title}`} onClick={() => edit({ ...page, items: page.items.filter(i => i.id !== item.id) })}>×</button>}</div>)}</div>
            <button type="button" className="everyday-add" disabled={page.items.length >= 100} onClick={() => edit({ ...page, items: [...page.items, { id: crypto.randomUUID(), title: "My extra item", quantity: 1, packed: false, custom: true }] })}>＋ Add something of my own</button>
          </section>
        </>}
      </fieldset>
      {dirty && <div className="everyday-save"><span>{version !== task.version ? "Changed elsewhere. Copy your edits before reopening." : page.type === "bill" ? "Ready? Let’s work out who owes whom." : "Keep your list for when it’s time to go."}</span><button type="button" className="burrow-link" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Discard changes</button><button className="burrow-primary" disabled={busy}>{busy ? "Saving…" : page.type === "bill" ? "Work out the split" : settingsChanged ? "Update my list" : "Save my list"}</button></div>}
    </form><aside className="everyday-aside">
      <KikkaReply activity={busy ? "working" : error || dirty ? "needs-you" : "ready"} revision={task.version} text={reply} />
      {error && <p role="alert" className="burrow-error">{error}</p>}
      {savedBill && !dirty && <section className="everyday-settlement"><p className="burrow-eyebrow">{savedBill.page.expenses.length ? "ALL WORKED OUT" : "NO COSTS YET"}</p><h2>{money(savedBill.summary.total_cents)} <small>total</small></h2>
        {savedBill.page.expenses.length === 0 ? <p>Add a cost to see who owes whom.</p> : <>{savedBill.summary.payments.length === 0 ? <p className="everyday-even">Everyone is even. Nice.</p> : <div className="everyday-payments">{savedBill.summary.payments.map((p,index) => <div key={index}><span><strong>{name(p.from)}</strong> pays <strong>{name(p.to)}</strong></span><b>{money(p.cents)}</b></div>)}</div>}
          <details><summary>How we split it</summary>{savedBill.summary.people.map(person => <p key={person.id}><strong>{name(person.id)}</strong><br />Paid {money(person.paid_cents)} · share {money(person.share_cents)}</p>)}<p>Each cost is shared equally by the people you chose. Extra cents go to earlier names in your list.</p></details><button className="burrow-secondary" type="button" onClick={() => void copySplit()}>{copied ? "Copied ✓" : "Copy the split"}</button><span role="status" className="sr-only">{copied ? "Split copied" : ""}</span></>}
        <p className="burrow-small">Suggested payments only. No money is moved.</p>
      </section>}
      {dirty && page.type === "bill" && <div className="everyday-notice">Choose “Work out the split” to see who owes whom after these changes.</div>}
      <p className="burrow-small everyday-privacy">Saved for you, not shared with other users. The people running Burrow can read saved pages.</p>
    </aside></div>
  </article>;
}
