import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { bundleEntry, fixtures } from "./fixtures/bundle.ts";
import type { TravelMoney, TravelQuote, TravelView } from "../src/api.ts";
import { Window } from "happy-dom";

test("fixture travel public result preserves exact saved state, separates prices and flags weak evidence", async () => {
  const bundle = await bundleEntry<{ renderSaved: (text: string) => string; parseTravelMoney: (text: string, currency: string) => TravelMoney; travelMoney: (money: TravelMoney) => string }>(join(fixtures, "travel.tsx"));
  try {
    const { renderSaved, parseTravelMoney, travelMoney } = bundle.mod;
    assert.deepEqual(parseTravelMoney("1050.01", "CAD"), { minor: 105001, currency: "CAD" });
    assert.equal(parseTravelMoney("1.001", "KWD").minor, 1001);
    assert.equal(parseTravelMoney("1050", "JPY").minor, 1050);
    assert.equal(travelMoney({ minor: -1, currency: "KWD" }), "KWD -0.001");
    for (const [amount, currency] of [["1.001", "CAD"], ["1.1", "JPY"], ["1e3", "USD"], ["-1", "USD"], ["0", "USD"], ["1", "XXX"], ["9007199254740992", "JPY"], ["1,000", "CAD"]]) assert.throws(() => parseTravelMoney(amount, currency));
    const quote: TravelQuote = { room: "Twin room", accommodation: { id: "hotel", name: "Fixture hotel", address: "Test address", latitude: 1, longitude: 1, city: "Test city", country_code: "CA", rating: 4 }, total: { minor: 105001, currency: "CAD" }, due_at_property: { minor: 0, currency: "CAD" }, cancellation: [], check_in: "2027-01-01", check_out: "2027-01-02", guests: [{ type: "adult" }, { type: "child", age: 8 }], rooms: 1, rate_id: "rate" };
    const material = { id: "source", name: "Research hotel", source_url: "https://example.com/hotel", fetched_at: 1, coords: null, displayed_price: "999.99", currency: "CAD", advisory: true as const };
    const value: TravelView = { mode: "fixture", stage: "booking_uncertain", reason: "Provider outcome unknown", root_goal_id: "goal", transaction_id: "transaction", terminal: false, selected_rate_id: "rate", comparison: { options: [{ rate: quote, distance_meters: 10, materials: [{ material, confidence: "low", distance_meters: 20 }] }], context: [{ ...material, id: "context", name: "Unmatched hotel" }] }, result: null };
    const saved = (v: TravelView) => JSON.stringify({ type: "travel", ...v });
    const uncertain = renderSaved(saved(value));
    assert.match(uncertain, /Fixture demo — no real booking/);
    assert.match(uncertain, /No verified booking is claimed/);
    assert.match(uncertain, /Provider outcome unknown/);
    assert.doesNotMatch(uncertain, /Fixture booking verified|Final verified price/);
    assert.match(uncertain, /Low-confidence match — identity not verified/);
    assert.match(uncertain, /Unmatched context — not bookable/);
    assert.match(uncertain, /Advisory research price: CAD 999.99/);
    assert.match(uncertain, /Provider quote total: <strong>CAD 1050.01/);
    const completed: TravelView = { ...value, stage: "completed", terminal: true, result: { booking: { id: "booking", status: "confirmed", confirmed_at: 1, reference: "FIXTURE-ONLY", guests: [] }, final_quote: quote, research_price: { minor: 99999, currency: "CAD" }, research_to_quote_difference_minor: 5002, selection_reason: "Within mandate", verified_at: 2, scope: {} } };
    const final = renderSaved(saved(completed));
    assert.match(final, /Final verified price: <strong>CAD 1050.01/);
    assert.match(final, /Difference: CAD 50.02/);
    assert.match(final, /FIXTURE-ONLY/);
    assert.doesNotMatch(renderSaved(saved({ ...completed, stage: "booking_uncertain" })), /Fixture booking verified|Final verified price/);
    const malformed = renderSaved(JSON.stringify({ type: "travel", mode: "fixture", stage: "completed", comparison: { options: [{}], context: [] } }));
    assert.doesNotMatch(malformed, /Fixture booking verified/);
    assert.equal(renderSaved(saved(value)), uncertain, "later completion must not replace an earlier saved envelope");
    assert.match(renderSaved(saved({ ...value, comparison: { options: [{ rate: quote, distance_meters: 10, materials: [] }], context: [] } })), /No matching research material/);
    assert.match(renderSaved("Manually edited travel note"), /Manually edited travel note/);
  } finally { await bundle.cleanup(); }
});

test("trip setup validates before writes and sends the supplied goal once with explicit adult and child profiles", async () => {
  const window = new Window({ url: "http://localhost/burrow" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const task = { id: "trip", version: 1, request: "My supplied trip goal" };
  let selected: unknown;
  const fetcher = async (url: string, init: RequestInit) => {
    writes.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/travel")) return Response.json({ task: { ...task, travel: true }, mode: "fixture" });
    return Response.json(task);
  };
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, FormData: window.FormData, fetch: fetcher })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown, props: unknown) => () => void }>(join(fixtures, "travel.tsx"));
  const container = window.document.createElement("div"); window.document.body.append(container);
  const unmount = bundle.mod.mount(container, { token: "fixture-session", goal: task.request, onCreated: (next: unknown) => { selected = next; }, onDirtyChange: () => {}, onCancel: () => {} });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const change = (input: HTMLInputElement, value: string) => bundle.mod.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const submit = () => bundle.mod.act(() => container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  try {
    assert.equal(writes.length, 0);
    const values = { maximum: "1050.001", country: "ca", city: "Ottawa", latitude: "45.4", longitude: "-75.7", radius: "1000", check_in: "2027-01-01", check_out: "2027-01-02", rooms: "1" };
    for (const [name, value] of Object.entries(values)) change(container.querySelector(`input[name="${name}"]`)!, value);
    submit(); await settle(); assert.equal(writes.length, 0); assert.match(container.textContent!, /decimal places/);
    change(container.querySelector('input[name="maximum"]')!, "1050.01");
    submit(); await settle(); assert.equal(writes.length, 0); assert.match(container.textContent!, /Complete every traveler profile/);
    bundle.mod.act(() => [...container.querySelectorAll("button")].find(b => b.textContent === "Add traveler")!.click());
    const guestSelects = [...container.querySelectorAll("fieldset fieldset select")];
    bundle.mod.act(() => { guestSelects[1].value = "child"; guestSelects[1].dispatchEvent(new window.Event("change", { bubbles: true })); });
    const profileFields = [...container.querySelectorAll("fieldset fieldset")];
    for (const [index, fieldset] of profileFields.entries()) {
      const inputs = [...fieldset.querySelectorAll("input")];
      if (index === 1) change(inputs.shift()!, "8");
      for (const [i, value] of ["User-selected", `Traveler-${index}`, "fixture@example.test", "+16135550100", index ? "2018-05-01" : "1990-05-01"].entries()) change(inputs[i], value);
    }
    submit(); await settle();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.request, task.request);
    assert.equal(writes[0].body.kind, "writing");
    assert.ok(writes[1].url.endsWith("/tasks/trip/travel"));
    assert.equal(writes[1].body.version, 1);
    const mandate = writes[1].body.mandate as Record<string, unknown>;
    assert.deepEqual(mandate.maximum, { minor: 105001, currency: "CAD" });
    assert.deepEqual(mandate.guests, [{ type: "adult" }, { type: "child", age: 8 }]);
    assert.equal(mandate.spend_capability_id, "fixture-balance");
    assert.equal(writes[1].body.materials, true);
    assert.equal((writes[1].body.travelers as unknown[]).length, 2);
    assert.deepEqual(selected, { ...task, travel: true });
    assert.equal(writes.filter(w => /agent|purchas|booking/.test(w.url)).length, 0, "setup never starts work or purchases");
  } finally {
    unmount(); await bundle.cleanup(); await window.happyDOM.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
