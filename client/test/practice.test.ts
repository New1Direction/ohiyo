import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
import type { BurrowTask, PracticeView, PresentationReview } from "../src/api.ts";

const window = new Window({ url: "http://localhost" }), document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<{ act: (cb: () => void) => void; mount: (el: unknown, task: BurrowTask, dirty: (value: boolean) => void) => { update: (task: BurrowTask) => void; unmount: () => void } }>;
const task = { id: "material", kind: "writing", format: "document", state: "draft_ready", result: "Water droplets form on cold surfaces.", proposed_result: "", version: 4, coding: false } as BurrowTask;
const route = { connectionId: "teacher-api", providerModelId: "general-model", endpoint: "https://example.org/v1/chat/completions", fundedBy: "you", maxOutputTokens: 1000, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 };
const pack = (): NonNullable<PracticeView["pack"]> => ({ id: "practice-pack", version: 2, revision: 1, state: "draft_ready", status: "draft", source_version: 4, stale: false, objective: "Explain droplets", audience: "Year 5", max_cost_cents: 10, error: null, content: {
  objective: "Explain droplets", explanation: { text: "Condensation explanation", quote: "Water droplets" }, worked_example: { text: "Cold glass example", quote: "cold surfaces" },
  questions: [0, 1, 2].map(i => ({ question: `Application ${i + 1}`, options: ["Warmer", "Colder"], answer: 1, explanation: `Feedback ${i + 1}`, quote: `quote-${i + 1}` })),
} });
let snapshot: PracticeView;
let presentation: PresentationReview;
let writes: { url: string; body: Record<string, unknown> }[] = [];
let reads: string[] = [];
let lose = false, subscription = false, dirty = false;
let hold: (() => void) | undefined;
let confirmDiscard = true;
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") reads.push(url);
      if (url.includes("model-routing")) return Response.json({ preview: { general: { ...route, connectionId: subscription ? "subscription-claude" : route.connectionId }, review: { ...route, providerModelId: "different-review-model" } } });
      if (url.endsWith("/presentation")) return Response.json(presentation);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push({ url, body });
        if (hold) await new Promise<void>(resolve => { hold = resolve; });
        if (lose) throw new Error("Lost acknowledgement");
        if (url.endsWith("/practice/review")) snapshot = { ...snapshot, pack: { ...snapshot.pack!, status: body.action === "approve" ? "approved" : "withdrawn", revision: snapshot.pack!.revision + 1 } };
        else if (url.endsWith("/practice")) snapshot = { ...snapshot, pack: { ...pack(), state: "working", content: null } };
      }
      return Response.json(snapshot);
    } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  window.confirm = () => confirmDiscard;
  bundle = await bundleEntry(join(fixtures, "practice.tsx"));
});
after(async () => { await bundle?.cleanup(); await window.happyDOM.close(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { await new Promise(r => setTimeout(r, 30)); bundle.mod.act(() => {}); };
async function mount(saved: PracticeView["pack"] = null, nextTask = task) {
  snapshot = { source_version: nextTask.version, pack: saved };
  presentation = { version: nextTask.version, approved: false, review: null, history: [], evaluation: null };
  writes = []; reads = []; lose = false; subscription = false; dirty = false; hold = undefined; confirmDiscard = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = bundle.mod.mount(container, nextTask, value => { dirty = value; }); await settle();
  const practice = container.querySelector<HTMLDetailsElement>(".practice-review")!;
  const click = async (label: string) => { const button = [...practice.querySelectorAll("button")].find(b => b.textContent === label); assert.ok(button, label); bundle.mod.act(() => button.click()); await settle(); };
  return { container, practice, update: root.update,
    button: (label: string) => [...practice.querySelectorAll("button")].find(b => b.textContent === label), click,
    open: async () => { bundle.mod.act(() => { practice.open = true; practice.dispatchEvent(new window.Event("toggle")); }); await settle(); },
    close: () => { root.unmount(); container.remove(); },
  };
}
function input(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  bundle.mod.act(() => {
    Object.getOwnPropertyDescriptor(field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function tick(field: HTMLInputElement) { bundle.mod.act(() => field.click()); }
function choices(practice: HTMLDetailsElement) {
  input(practice.querySelector("textarea")!, "Explain droplets");
  input(practice.querySelector('input:not([type="checkbox"]):not([type="number"])')!, "Year 5");
}

test("opening only reads; consent discloses general route, clears on edits, and pending generation is single-shot", async () => {
  const f = await mount();
  try {
    assert.equal(reads.some(url => url.includes("/practice")), false);
    await f.open(); assert.equal(writes.length, 0); assert.equal(reads.filter(url => url.endsWith("/practice")).length, 1);
    assert.match(f.practice.textContent!, /general-model via example.org/); assert.doesNotMatch(f.practice.textContent!, /different-review-model/);
    assert.match(f.practice.textContent!, /No Ohiyo chats, project context or separate review sources are included/);
    assert.match(f.practice.textContent!, /notes only if they are part of this saved document/);
    const generate = () => f.button("Allow one practice generation")!;
    choices(f.practice); assert.equal(generate().disabled, true); assert.equal(dirty, true, "practice dirty state reaches parent review guard");
    const consent = f.practice.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    tick(consent); assert.equal(generate().disabled, false);
    input(f.practice.querySelector('input[type="number"]')!, "0"); assert.equal(consent.checked, false); tick(consent);
    input(f.practice.querySelector("textarea")!, "Explain condensation"); assert.equal(consent.checked, false); tick(consent);
    input(f.practice.querySelector('input:not([type="checkbox"]):not([type="number"])')!, "Year 6"); assert.equal(consent.checked, false); tick(consent);
    hold = () => {};
    await f.click("Allow one practice generation"); assert.equal(generate().disabled, true); await f.click("Allow one practice generation"); assert.equal(writes.length, 1);
    assert.equal(writes[0].body.allow_practice, true); assert.equal(writes[0].body.version, 4); assert.equal(writes[0].body.max_cost_cents, 0);
    assert.equal((writes[0].body.routing as { general: typeof route }).general.providerModelId, "general-model");
    hold!(); await settle(); assert.equal(f.button("Allow one practice generation"), undefined); assert.equal(dirty, false);
    await f.click("Refresh practice"); assert.equal(writes.length, 1);
  } finally { f.close(); }
});

test("human review exposes every key and quote, needs two fresh checks, then trusted Quiz reveals feedback only after an answer", async () => {
  const f = await mount(pack());
  try {
    await f.open(); assert.equal(writes.length, 0); assert.equal(f.practice.querySelector(".gen-quiz"), null);
    assert.equal(f.practice.querySelectorAll(".presentation-source").length, 3);
    for (const i of [1, 2, 3]) { assert.match(f.practice.textContent!, new RegExp(`Feedback ${i}`)); assert.match(f.practice.textContent!, new RegExp(`quote-${i}`)); }
    assert.equal(f.button("Approve private practice")!.disabled, true);
    const checks = f.practice.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); assert.equal(checks.length, 2); assert.equal(checks[0].checked, false); assert.equal(checks[1].checked, false);
    tick(checks[0]); assert.equal(f.button("Approve private practice")!.disabled, true); tick(checks[1]);
    await f.click("Approve private practice"); assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { version: 4, pack_id: "practice-pack", pack_version: 2, revision: 1, action: "approve", answers_checked: true, age_checked: true });
    assert.equal(f.container.querySelector('section[aria-label="Approved audience and sources"]'), null, "private approval does not approve the deck");
    assert.equal(f.practice.querySelector('section[aria-label="Practice answer review"]'), null);
    const quiz = f.practice.querySelector(".gen-quiz")!; assert.ok(quiz);
    assert.doesNotMatch(quiz.textContent!, /Feedback 1|quote-1/); assert.equal(f.practice.querySelector<HTMLDetailsElement>(".gen-reveal")!.open, false);
    bundle.mod.act(() => quiz.querySelector<HTMLButtonElement>(".gen-answers button")!.click()); await settle();
    assert.match(quiz.textContent!, /Feedback 1/); assert.match(quiz.textContent!, /From saved material version 4: “quote-1”/);
    assert.equal(writes.length, 1, "answer is local, no request"); assert.equal(dirty, false);
    await f.click("Withdraw practice approval"); assert.equal(writes.length, 1); await f.click("Keep practice approval"); assert.equal(writes.length, 1);
    await f.click("Withdraw practice approval"); await f.click("Confirm practice withdrawal"); assert.equal(writes[1].body.action, "withdraw"); assert.equal(f.practice.querySelector(".gen-quiz"), null);
  } finally { f.close(); }
});

test("ambiguous generation locks mutations, preserves choices until explicit refresh, and never auto retries", async () => {
  const f = await mount();
  try {
    await f.open(); choices(f.practice); tick(f.practice.querySelector<HTMLInputElement>('input[type="checkbox"]')!); lose = true;
    await f.click("Allow one practice generation"); assert.equal(writes.length, 1); assert.equal(f.button("Allow one practice generation")!.disabled, true); assert.match(f.practice.textContent!, /No action will repeat automatically/);
    confirmDiscard = false; const previousReads = reads.length; await f.click("Refresh practice"); assert.equal(reads.length, previousReads); assert.equal(f.practice.querySelector<HTMLTextAreaElement>("textarea")!.value, "Explain droplets");
    lose = false; confirmDiscard = true; snapshot = { source_version: 4, pack: { ...pack(), state: "working", content: null } };
    await f.click("Refresh practice"); assert.equal(writes.length, 1); assert.equal(f.button("Allow one practice generation"), undefined);
    lose = true; await f.click("Stop practice generation"); assert.equal(writes.length, 2); assert.match(writes[1].url, /practice-pack\/agent\/control$/); assert.equal(writes[1].body.action, "stop"); assert.equal(writes[1].body.version, 2);
    assert.equal(f.button("Stop practice generation")!.disabled, true); assert.match(f.practice.textContent!, /Refresh practice to check/);
    lose = false; snapshot = { source_version: 4, pack: { ...pack(), state: "failed", content: null } }; await f.click("Refresh practice"); assert.equal(writes.length, 2); assert.equal(f.button("Allow one practice generation"), undefined);
  } finally { f.close(); }
});

test("source version changes invalidate approval even for restored text; old packs read-only and new versions get a separate explicit allowance", async () => {
  const f = await mount({ ...pack(), status: "approved", stale: true, source_version: 3, history: [{ revision: 1, output_version: 2, status: "approved", created_at: 1 }] });
  try {
    await f.open(); assert.match(f.practice.textContent!, /read-only/); assert.equal(f.practice.querySelector(".gen-quiz"), null); assert.equal(f.button("Approve private practice"), undefined); assert.equal(f.button("Withdraw practice approval"), undefined);
    const history = [...f.practice.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Practice approval history")!;
    assert.equal(history.open, false); assert.match(history.textContent!, /decision 1 · output version 2/);
    assert.ok(f.button("Allow one practice generation")); assert.equal(writes.length, 0);
    snapshot = { source_version: 4, pack: { ...pack(), status: "approved" } }; await f.click("Refresh practice"); assert.ok(f.practice.querySelector(".gen-quiz"));
    snapshot = { source_version: 5, pack: { ...pack(), status: "approved", stale: true } };
    bundle.mod.act(() => f.update({ ...task, version: 5 })); await settle(); assert.equal(f.practice.querySelector(".gen-quiz"), null); assert.match(f.practice.textContent!, /same text was restored/); assert.ok(f.button("Allow one practice generation")); assert.equal(writes.length, 0);
    snapshot = { source_version: 5, pack: { ...pack(), state: "working", content: null, stale: true } };
    await f.click("Refresh practice");
    assert.equal(f.button("Stop practice generation")!.disabled, false, "source edits cannot remove the ability to stop earlier generation");
    await f.click("Stop practice generation"); assert.equal(writes.length, 1); assert.equal(writes[0].body.action, "stop");
  } finally { f.close(); }
});

test("unsupported or proposed material does not even load practice; malformed output and subscription models cannot be used", async () => {
  for (const change of [{ format: "creation" as const }, { proposed_result: "Proposed text" }, { state: "working" as const }, { result: "" }, { coding: true }, { comparison: true }, { travel: true }, { template: "bill" as const }]) {
    const f = await mount(null, { ...task, ...change });
    try { await f.open(); assert.equal(reads.some(url => url.includes("/practice")), false); assert.equal(f.button("Allow one practice generation"), undefined); } finally { f.close(); }
  }
  const malformed = pack(); malformed.content!.questions[0].answer = 8;
  const f = await mount(malformed);
  try { await f.open(); assert.match(f.practice.textContent!, /cannot be displayed safely/); assert.equal(f.button("Approve private practice"), undefined); } finally { f.close(); }
  const s = await mount(); subscription = true;
  try { await s.open(); choices(s.practice); tick(s.practice.querySelector<HTMLInputElement>('input[type="checkbox"]')!); assert.equal(s.button("Allow one practice generation")!.disabled, true); assert.match(s.practice.textContent!, /Subscription billing cannot enforce/); } finally { s.close(); }
});

test("uncertain approval waits for a read-only refresh; human checks reset and temporary answers are never persisted", async () => {
  const f = await mount(pack());
  try {
    await f.open(); const checks = f.practice.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); tick(checks[0]); tick(checks[1]);
    lose = true; await f.click("Approve private practice"); assert.equal(writes.length, 1); assert.equal(f.button("Approve private practice")!.disabled, true); assert.equal(checks[0].checked, false); assert.equal(checks[1].checked, false);
    assert.equal(f.practice.querySelector(".gen-quiz"), null); assert.equal(dirty, true);
    lose = false; snapshot = { source_version: 4, pack: { ...pack(), status: "approved", revision: 2 } }; await f.click("Refresh practice");
    assert.equal(writes.length, 1); assert.equal(dirty, false); assert.ok(f.practice.querySelector(".gen-quiz"));
    bundle.mod.act(() => f.practice.querySelector<HTMLButtonElement>(".gen-answers button")!.click()); await settle();
    assert.match(f.practice.querySelector(".gen-quiz")!.textContent!, /Feedback 1/); assert.equal(writes.length, 1);
  } finally { f.close(); }
  const next = await mount({ ...pack(), status: "approved", revision: 2 });
  try { await next.open(); assert.doesNotMatch(next.practice.querySelector(".gen-quiz")!.textContent!, /Feedback 1/); assert.equal(writes.length, 0); } finally { next.close(); }
});
