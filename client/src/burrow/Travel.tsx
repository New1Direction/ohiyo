import { useEffect, useState, type FormEvent } from "react";
import { api, type BurrowTask, type Traveler, type TravelGuest, type TravelMandate, type TravelMaterial, type TravelMoney, type TravelQuote, type TravelView } from "../api";
import { SavedResearchText } from "./ResearchComparison";
import { z } from "zod";

const exponents: Record<string, number> = { CAD: 2, USD: 2, GBP: 2, EUR: 2, AUD: 2, NZD: 2, CHF: 2, JPY: 0, KWD: 3, BHD: 3 };
export function parseTravelMoney(amount: string, currency: string): TravelMoney {
  const exponent = exponents[currency];
  if (typeof exponent !== "number" || amount.length > 32 || !/^\d+(\.\d+)?$/.test(amount)) throw new Error("Enter an exact positive decimal amount and supported currency.");
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > exponent) throw new Error(`This currency allows ${exponent} decimal places.`);
  const minor = BigInt(whole + fraction.padEnd(exponent, "0"));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is outside the supported range.");
  return { minor: Number(minor), currency };
}
export function travelMoney(money: TravelMoney): string {
  const exponent = exponents[money.currency];
  if (typeof exponent !== "number" || !Number.isSafeInteger(money.minor)) return "Price unavailable";
  const digits = String(Math.abs(money.minor)).padStart(exponent + 1, "0");
  return `${money.currency} ${money.minor < 0 ? "-" : ""}${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits}`;
}
function Material({ value, label }: { value: TravelMaterial; label: string }) {
  const safe = /^https?:\/\//i.test(value.source_url);
  return <div className="burrow-request-details"><strong>{label}</strong><p>{safe ? <a href={value.source_url} target="_blank" rel="noreferrer">{value.name}</a> : value.name}</p><p>Advisory research price: {value.displayed_price === null ? "unavailable" : `${value.currency ?? "Currency unknown"} ${value.displayed_price}`} — not a final quote or bookable offer.</p><small>Source fetched {new Date(value.fetched_at * 1000).toLocaleString()}</small></div>;
}
function Quote({ value }: { value: TravelQuote }) {
  return <><h3>{value.accommodation.name} · {value.room}</h3><p>{value.accommodation.address} · {value.check_in} → {value.check_out} · {value.rooms} room(s), {value.guests.length} guest(s)</p><p>Provider quote total: <strong>{travelMoney(value.total)}</strong> · Due at property: {travelMoney(value.due_at_property)}</p><p>Cancellation: {value.cancellation.length ? value.cancellation.map(c => `${travelMoney(c.refund)} refunded before ${new Date(c.before * 1000).toLocaleString()}`).join("; ") : "No refund schedule supplied"}</p></>;
}
export function TravelResult({ value }: { value: TravelView }) {
  const verified = value.stage === "completed" && value.result !== null;
  return <section className="burrow-document" aria-label="Travel result"><p className="burrow-tag">Fixture demo — no real booking</p><h2>{verified ? "Fixture booking verified" : value.stage.replace(/_/g, " ")}</h2><p role="status">{verified ? "Completed in the fixture only." : "No verified booking is claimed. Do not retry an uncertain booking; it needs reconciliation."}</p>{value.reason && <p className={verified ? "burrow-small" : "burrow-error"}>{value.reason}</p>}
    {verified && value.result && <section><Quote value={value.result.final_quote} /><p>Final verified price: <strong>{travelMoney(value.result.final_quote.total)}</strong></p><p>Research price: {value.result.research_price ? travelMoney(value.result.research_price) : "unavailable"} · Difference: {value.result.research_to_quote_difference_minor === null ? "unavailable (no comparable research price)" : travelMoney({ minor: value.result.research_to_quote_difference_minor, currency: value.result.final_quote.total.currency })}</p><p>{value.result.selection_reason}</p><p>Guests: {value.result.booking.guests.map(g => `${g.given_name} ${g.family_name}`).join(", ")}</p><p>Provider booking ID: {value.result.booking.id}<br />Fixture reference: {value.result.booking.reference} · Status: {value.result.booking.status}<br />Confirmed {value.result.booking.confirmed_at === null ? "time unavailable" : new Date(value.result.booking.confirmed_at * 1000).toLocaleString()} · Verified {new Date(value.result.verified_at * 1000).toLocaleString()}</p></section>}
    {value.comparison.options.map(option => <section key={option.rate.rate_id}><Quote value={option.rate} /><p>{Math.round(option.distance_meters)} m from requested centre{value.selected_rate_id === option.rate.rate_id ? " · Selected fixture rate" : ""}</p>{option.materials.length === 0 && <p>No matching research material. Provider quote only.</p>}{option.materials.map(match => <Material key={match.material.id} value={match.material} label={match.confidence === "low" ? `Low-confidence match — identity not verified (${Math.round(match.distance_meters)} m)` : `Research match (${Math.round(match.distance_meters)} m)`} />)}</section>)}
    {value.comparison.context.length > 0 && <section><h3>Unmatched context — not bookable</h3>{value.comparison.context.map(m => <Material key={m.id} value={m} label="Advisory context only — not matched to a provider rate" />)}</section>}
  </section>;
}
// Saved results remain editable text. A partially edited JSON envelope must not
// crash the studio or turn a malformed result into a booking confirmation.
const moneySchema = z.object({ minor: z.number().int().safe(), currency: z.string() });
const materialSchema = z.object({ id: z.string(), name: z.string(), source_url: z.string(), fetched_at: z.number(), coords: z.object({ lat: z.number(), lng: z.number() }).nullable(), displayed_price: z.string().nullable(), currency: z.string().nullable(), advisory: z.literal(true) });
const guestSchema = z.union([z.object({ type: z.literal("adult") }), z.object({ type: z.literal("child"), age: z.number().int() })]);
const quoteSchema = z.object({ room: z.string(), accommodation: z.object({ name: z.string(), address: z.string(), latitude: z.number(), longitude: z.number(), id: z.string(), city: z.string(), country_code: z.string(), rating: z.number().nullable() }), total: moneySchema, due_at_property: moneySchema, cancellation: z.array(z.object({ before: z.number(), refund: moneySchema })), check_in: z.string(), check_out: z.string(), guests: z.array(guestSchema), rooms: z.number(), rate_id: z.string() });
const viewSchema = z.object({ mode: z.literal("fixture"), stage: z.string(), reason: z.string().nullable(), root_goal_id: z.string().nullable(), transaction_id: z.string().nullable(), terminal: z.boolean(), comparison: z.object({ options: z.array(z.object({ rate: quoteSchema, distance_meters: z.number(), materials: z.array(z.object({ material: materialSchema, confidence: z.enum(["high", "low"]), distance_meters: z.number() })) })), context: z.array(materialSchema) }), selected_rate_id: z.string().nullable(), result: z.object({ booking: z.object({ id: z.string(), status: z.string(), confirmed_at: z.number().nullable(), reference: z.string().nullable(), guests: z.array(z.object({ given_name: z.string(), family_name: z.string() })) }), final_quote: quoteSchema, research_price: moneySchema.nullable(), research_to_quote_difference_minor: z.number().int().safe().nullable(), selection_reason: z.string(), verified_at: z.number(), scope: z.unknown() }).nullable() });
export function parseTravelResult(text: string): TravelView | null {
  try { const v = JSON.parse(text); return v?.type === "travel" && viewSchema.safeParse(v).success ? v as TravelView : null; } catch { return null; }
}
export function SavedTravelText({ text }: { text: string }) { const value = parseTravelResult(text); return value ? <TravelResult value={value} /> : <SavedResearchText text={text} />; }
export function TravelProgress({ token, id }: { token: string; id: string }) {
  const [value, setValue] = useState<TravelView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const refresh = async () => { try { const next = await api.burrowTravel(token, id); if (!viewSchema.safeParse(next).success) throw new Error("Invalid travel view"); if (alive) { setValue(next); setError(""); } } catch { if (alive) setError("Travel progress unavailable; displayed progress may be out of date. This does not confirm a booking or a stop."); } };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [token, id]);
  return <details className="burrow-request-details"><summary>Live fixture progress: {value?.stage.replace(/_/g, " ") ?? "checking"} (not a saved version)</summary>{error && <p role="alert">{error}</p>}{value ? <TravelResult value={value} /> : <p>Checking fixture progress…</p>}</details>;
}

const blankProfile = (): Traveler => ({ given_name: "", family_name: "", email: "", phone: "", born_on: "" });
export default function Travel({ token, goal, onCreated, onDirtyChange, onCancel }: { token: string; goal: string; onCreated: (task: BurrowTask) => void; onDirtyChange: (dirty: boolean) => void; onCancel: () => void }) {
  const [travelers, setTravelers] = useState<Traveler[]>([blankProfile()]);
  const [guests, setGuests] = useState<TravelGuest[]>([{ type: "adult" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState<BurrowTask | null>(null);
  useEffect(() => {
    onDirtyChange(true);
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => { onDirtyChange(false); window.removeEventListener("beforeunload", warn); };
  }, [onDirtyChange]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || submitted) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    let attempted = false;
    setError("");
    try {
      const maximum = parseTravelMoney(text("maximum"), text("currency"));
      const check_in = text("check_in"), check_out = text("check_out");
      const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s).toISOString().slice(0, 10) === s;
      if (!goal.trim() || !validDate(check_in) || !validDate(check_out) || check_out <= check_in) throw new Error("Supply a goal and valid check-in/check-out dates in order.");
      if (travelers.some(t => Object.values(t).some(v => !v.trim()) || !validDate(t.born_on) || t.born_on >= check_in)) throw new Error("Complete every traveler profile with a valid birth date before the trip.");
      if (!guests.some(g => g.type === "adult") || guests.some(g => g.type === "child" && (!Number.isInteger(g.age) || g.age < 0 || g.age > 17))) throw new Error("Include an adult and explicit child ages from 0–17.");
      const latitude = Number(text("latitude")), longitude = Number(text("longitude")), radius_meters = Number(text("radius")), rooms = Number(text("rooms"));
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(radius_meters) || radius_meters <= 0 || !Number.isInteger(rooms) || rooms < 1) throw new Error("Check location, radius and room count.");
      const mandate: TravelMandate = { maximum, country_code: text("country").toUpperCase(), city: text("city"), area: { latitude, longitude, radius_meters }, check_in, check_out, rooms, guests, require_refundable: form.has("refundable"), accommodation_ids: [], minimum_rating: text("rating") ? Number(text("rating")) : null, preferences: text("preferences").split(",").map(s => s.trim()).filter(Boolean), amenity_preferences: text("amenities").split(",").map(s => s.trim()).filter(Boolean), bed_type: text("bed") || null, substitution_tolerance: "within_area", spend_capability_id: "fixture-balance" };
      if (!/^[A-Z]{2}$/.test(mandate.country_code) || !mandate.city) throw new Error("Supply a two-letter country code and city.");
      if (mandate.minimum_rating !== null && (!Number.isInteger(mandate.minimum_rating) || mandate.minimum_rating < 1 || mandate.minimum_rating > 5)) throw new Error("Minimum rating must be a whole number from 1–5.");
      if (new Date(check_out).getTime() - new Date(check_in).getTime() > 99 * 86400000) throw new Error("A stay must be no longer than 99 nights.");
      attempted = true; setSubmitted(true); setBusy(true);
      const task = await api.createBurrowTask(token, goal, "writing"); setPending(task);
      const answer = await api.attachBurrowTravel(token, task, mandate, travelers, form.has("materials"));
      onCreated(answer.task);
    } catch (e) { setError(!attempted && e instanceof Error ? e.message : "Couldn’t confirm fixture setup. Do not create another booking attempt; reopen the saved task to inspect its status."); }
    finally { setBusy(false); }
  }
  return <section className="burrow-detail"><h1>Plan a trip</h1><p className="burrow-tag">Fixture demo — no real booking</p><p>{goal}</p><p>Structured limits and traveler profiles are stored on this server, not end-to-end encrypted. Setup does not start work; review the normal work approval next. No real purchase authorization is granted.</p>
    <form className="burrow-login burrow-travel-form" onSubmit={submit}>
      <fieldset disabled={busy || submitted}><legend>Trip mandate</legend>
        <label>Maximum total<input name="maximum" inputMode="decimal" required /></label><label>Currency<select name="currency">{Object.keys(exponents).map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Country code<input name="country" pattern="[A-Za-z]{2}" maxLength={2} required /></label><label>City<input name="city" required /></label>
        <label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" required /></label><label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" required /></label><label>Area radius (metres)<input name="radius" type="number" min="1" required /></label>
        <label>Check-in<input name="check_in" type="date" required /></label><label>Check-out<input name="check_out" type="date" required /></label><label>Rooms<input name="rooms" type="number" min="1" max="20" defaultValue="1" required /></label>
        <label><input name="refundable" type="checkbox" defaultChecked /> Require refundable</label><p>Substitutions allowed only within the specified area. No property IDs are preselected.</p>
        <label>Minimum rating (optional)<input name="rating" type="number" min="1" max="5" step="1" /></label><label>Preferences (comma-separated)<input name="preferences" /></label><label>Amenities (comma-separated)<input name="amenities" /></label><label>Bed type (optional)<input name="bed" /></label><label><input name="materials" type="checkbox" defaultChecked /> Include advisory web research materials</label>
        {travelers.map((traveler, index) => <fieldset key={index}><legend>Traveler {index + 1} — stored profile</legend><label>Guest type<select value={guests[index].type} onChange={e => setGuests(old => old.map((g, i) => i === index ? e.target.value === "adult" ? { type: "adult" } : { type: "child", age: 0 } : g))}><option value="adult">Adult</option><option value="child">Child</option></select></label>{guests[index].type === "child" && <label>Child age at booking<input type="number" min="0" max="17" required value={guests[index].age} onChange={e => setGuests(old => old.map((g, i) => i === index ? { type: "child", age: Number(e.target.value) } : g))} /></label>}{(Object.keys(traveler) as (keyof Traveler)[]).map(key => <label key={key}>{key.replace(/_/g, " ")}<input required type={key === "born_on" ? "date" : key === "email" ? "email" : key === "phone" ? "tel" : "text"} value={traveler[key]} onChange={e => setTravelers(old => old.map((t, i) => i === index ? { ...t, [key]: e.target.value } : t))} /></label>)}{index > 0 && <button type="button" className="burrow-link" onClick={() => { setTravelers(old => old.filter((_, i) => i !== index)); setGuests(old => old.filter((_, i) => i !== index)); }}>Remove traveler {index + 1}</button>}</fieldset>)}
        <button type="button" className="burrow-secondary" onClick={() => { setTravelers(old => [...old, blankProfile()]); setGuests(old => [...old, { type: "adult" }]); }}>Add traveler</button>
      </fieldset>
      {error && <p className="burrow-error" role="alert">{error}</p>}{pending && !busy && <p>Task saved, setup outcome may be uncertain. <button type="button" className="burrow-link" onClick={() => onCreated(pending)}>Open saved task</button></p>}
      <button className="burrow-primary" disabled={busy || submitted}>{busy ? "Saving fixture mandate…" : "Save fixture trip"}</button><button type="button" className="burrow-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </form>
  </section>;
}
