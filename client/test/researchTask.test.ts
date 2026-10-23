import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures } from "./fixtures/bundle.ts";
import type { BurrowAgent, BurrowTask, ResearchWorkspace, ResearchChange } from "../src/api.ts";

test("research restores account-scoped reading places without executing work and reviews the exact revision", async () => {
  const window = new Window({ url: "http://localhost/burrow" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  let task: BurrowTask = { id: "supplier-task", kind: "writing", format: "document", template: null, request: "Compare cotton suppliers for Canada", project: "Shirts", comparison: true, state: "draft_ready", result: "Comparison\nQuote CAD 1,050\nCanada delivery", error: null, version: 2, created_at: 10, updated_at: 20 };
  const first = task.result;
  let agent: BurrowAgent = { task, agent: { id: "run-one", runtime_id: "runtime", phase: "finished", activity: "Saved comparison", max_cost_cents: 17 }, connected: true, commands: [], events: [{ seq: 1, type: "final_message", data: { content: first } }], history: [] };
  const memory = { id: "cotton-memory", project: "Shirts", text: "100% cotton; delivery to Canada", source_task: task.id, version: 1, created_at: 10, updated_at: 20 };
  let stopAttempts = 0;
  let saveStatus = 409;
  const fetcher = async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== "GET") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/keep-result")) { task = { ...task, proposed_result: "", version: task.version + 1 }; agent.task = task; return Response.json(task); }
      if (url.endsWith("/result")) return new Response("SQLITE_INTERNAL backend diagnostic", { status: saveStatus });
      if (url.includes("/memories/")) return new Response("owner_id mismatch backend diagnostic", { status: 403 });
      if (url.endsWith("/control")) {
        const body = writes.at(-1)!.body;
        if (body.action !== "stop" || ++stopAttempts === 1) throw new TypeError("Uncertain delivery");
        agent.commands.push([String(body.request_id), "stop", "", "sent"]);
        return Response.json(task);
      }
      throw new Error(`Unexpected write: ${url}`);
    }
    if (url.includes("/model-routing")) return Response.json({ catalog: [], roles: {}, preview: {}, connections: [] });
    if (url.includes("/context")) return Response.json({ memories: [memory], routines: [], history: [] });
    if (url.endsWith("/agent")) return Response.json({ ...agent, task });
    throw new Error(`Unexpected read: ${url}`);
  };
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, sessionStorage: window.sessionStorage, fetch: fetcher, requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown, props: unknown) => { render: (props: unknown) => void; unmount: () => void } }>(join(fixtures, "researchTask.tsx"));
  const container = window.document.createElement("div"); window.document.body.append(container);
  let dirty = false;
  let view: ReturnType<typeof bundle.mod.mount>;
  const props = (token = "account-one") => ({ token, task, canRun: true, onUpdate: (next: BurrowTask) => { task = next; view.render(props(token)); }, onDirtyChange: (value: boolean) => { dirty = value; } });
  const click = (text: string) => bundle.mod.act(() => { const b = [...container.querySelectorAll("button")].find(b => b.textContent === text); assert.ok(b, text); b.click(); });
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    view = bundle.mod.mount(container, props()); await settle();
    assert.equal(writes.length, 0);
    assert.match(container.querySelector(".burrow-context")!.textContent!, /100% cotton; delivery to Canada/);
    assert.match(container.querySelector(".research-controls")!.textContent!, /USD 0.17/);
    click("Edit");
    const memoryEditor = container.querySelector<HTMLTextAreaElement>(".burrow-context textarea")!;
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    bundle.mod.act(() => { set.call(memoryEditor, "100% cotton; delivery to Germany"); memoryEditor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal(dirty, true, "navigation must protect an unsaved saved-choice correction");
    click("Cancel"); assert.equal(dirty, false);
    click("Sources (0)");
    const pane = container.querySelector<HTMLElement>(".research-result-pane .research-scroll")!;
    pane.scrollTop = 163; bundle.mod.act(() => pane.dispatchEvent(new window.Event("scroll")));
    view.unmount();
    view = bundle.mod.mount(container, props()); await settle(); click("Pick up here"); await settle();
    assert.equal(container.querySelector('.research-result-tabs button[aria-pressed="true"]')!.textContent, "Sources (0)");
    assert.equal(container.querySelector<HTMLElement>(".research-result-pane .research-scroll")!.scrollTop, 163);
    view.unmount();
    task = { ...task, result: "Comparison\nQuote CAD 1,260\nCanada delivery", version: 3 };
    agent = { ...agent, task, events: [...agent.events, { seq: 8, type: "final_message", data: { content: task.result } }], history: [[5, first]] };
    view = bundle.mod.mount(container, props()); await settle();
    assert.match(container.querySelector(".research-return")!.textContent!, /result changed/);
    click("Pick up here"); await settle();
    assert.equal(container.querySelector(".research-diff del")!.textContent, "Quote CAD 1,050");
    assert.equal(container.querySelector(".research-diff ins")!.textContent, "Quote CAD 1,260");
    assert.match(container.querySelector(".research-changes")!.textContent!, /USD 0.17. Unchanged/);
    assert.equal(writes.length, 0, "opening, restoring and reviewing never start or resume work");
    click("Close changes"); view.unmount();
    view = bundle.mod.mount(container, props("account-two")); await settle();
    assert.equal(container.querySelector(".research-return"), null, "another sign-in cannot inherit this reading place");
    view.unmount();
    task = { ...task, manual_edited: true, proposed_result: "Comparison\nQuote CAD 1,310\nCanada delivery", version: 4 };
    agent.task = task;
    view = bundle.mod.mount(container, props()); await settle(); click("What changed?"); await settle();
    assert.equal(container.querySelector(".research-diff ins")!.textContent, "Quote CAD 1,310");
    task = { ...task, proposed_result: "Comparison\nQuote CAD 1,400\nCanada delivery", version: 5 }; agent.task = task;
    view.render(props()); await settle();
    assert.equal(container.querySelector(".research-diff ins")!.textContent, "Quote CAD 1,310", "polling must not change the proposal already being reviewed");
    assert.ok([...container.querySelectorAll("button")].find(b => b.textContent === "Use this revision")!.disabled);
    click("What changed?"); await settle();
    assert.equal(container.querySelector(".research-diff ins")!.textContent, "Quote CAD 1,400");
    click("Keep my edits"); await settle();
    assert.equal(writes.length, 1); assert.ok(writes[0].url.endsWith("/keep-result")); assert.deepEqual(writes[0].body, { version: 5 });
    assert.equal(task.result, "Comparison\nQuote CAD 1,260\nCanada delivery"); assert.equal(task.manual_edited, true); assert.equal(task.proposed_result, "");
    click("Edit result");
    const editor = container.querySelector<HTMLTextAreaElement>("#research-result")!;
    bundle.mod.act(() => { set.call(editor, "My unsaved result"); editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal(dirty, true, "navigation must protect unsaved result edits");
    assert.ok(!Object.keys(window.sessionStorage).some(key => key.includes("account-one")));
    for (let i = 0; i < window.sessionStorage.length; i++) { const raw = window.sessionStorage.getItem(window.sessionStorage.key(i)!)!; assert.doesNotMatch(raw, /Quote CAD|cotton|Canada|account-one/); }
    view.unmount();
    task = { ...task, state: "working", version: 7 };
    agent = { ...agent, task, agent: { ...agent.agent, phase: "attached", activity: "Reading https://supplier.example/catalog?country=CA…" }, commands: [
      ["q", "steer", "Check cotton", "queued"], ["d", "steer", "Check delivery", "dispatching"],
      ["s", "steer", "Check quantity", "sent"], ["r", "steer", "Check price", "review"],
      ["x", "steer", "Old instruction", "discarded"], ["u", "steer", "Unknown instruction", "future_phase"],
    ] };
    view = bundle.mod.mount(container, props()); await settle();
    assert.match(container.querySelector(".research-conversation")!.textContent!, /Reading supplier.example…/);
    const followUps = [...container.querySelectorAll(".research-user-message span")].slice(1).map(s => s.textContent);
    assert.deepEqual(followUps, ["Your instruction · Waiting to send", "Your instruction · Sending to Kikka…", "Your instruction · Sent to Kikka", "Your instruction · Delivery needs checking", "Your instruction · Not sent", "Your instruction · Status unavailable"]);
    assert.doesNotMatch(followUps.join(" "), /Applied|future_phase|dispatching/);
    assert.match(container.querySelector(".research-receipt")!.textContent!, /Status unavailable/);
    assert.doesNotMatch(container.querySelector(".research-receipt")!.textContent!, /Delivery confirmed/);
    const instruction = container.querySelector<HTMLTextAreaElement>("#research-instruction")!;
    bundle.mod.act(() => { set.call(instruction, "Compare old pages"); instruction.dispatchEvent(new window.Event("input", { bubbles: true })); instruction.setSelectionRange(8, 11); });
    click("👍"); await settle();
    assert.equal(instruction.value, "Compare 👍 pages", "emoji replaces the selected text instead of appending or sending");
    assert.equal(instruction.selectionStart, 10); assert.equal(window.document.activeElement, instruction);
    assert.equal(writes.length, 1, "choosing an emoji never sends a message or starts work");
    bundle.mod.act(() => { set.call(instruction, "x".repeat(8000)); instruction.dispatchEvent(new window.Event("input", { bubbles: true })); instruction.setSelectionRange(8000, 8000); });
    click("👍"); await settle();
    assert.equal(instruction.value.length, 8000);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /message is full/);
    bundle.mod.act(() => instruction.setSelectionRange(7998, 8000)); click("👍"); await settle();
    assert.equal(instruction.value, "x".repeat(7998) + "👍", "replacement still works at the message limit");
    bundle.mod.act(() => { set.call(instruction, "Check minimum order quantities"); instruction.dispatchEvent(new window.Event("input", { bubbles: true })); });
    bundle.mod.act(() => instruction.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(writes.length, 1, "Shift+Enter never sends research instructions");
    bundle.mod.act(() => instruction.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await settle();
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Couldn’t confirm that your instruction arrived/);
    assert.equal(instruction.value, "Check minimum order quantities", "a failed keyboard send keeps the draft");
    click("Stop"); await settle();
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /not confirmed stopped yet/);
    click("Stop"); await settle();
    const controls = writes.filter(w => w.url.endsWith("/control"));
    assert.deepEqual(controls.map(c => c.body.action), ["steer", "stop", "stop"], "an uncertain instruction cannot block Stop");
    assert.equal(controls[1].body.request_id, controls[2].body.request_id, "uncertain Stop retries retain the same ID");
    assert.ok(controls.every(c => c.body.allow_spending === false));
    assert.equal(container.querySelector(".research-toolbar [role=status]")!.textContent, "Stopping");
    assert.match(container.querySelector(".research-conversation")!.textContent!, /Waiting for Kikka to confirm; work may still be running/);
    task = { ...task, state: "failed", error: "Stopped by you.", version: 8 }; agent.task = task; view.render(props());
    assert.equal(container.querySelector(".research-toolbar [role=status]")!.textContent, "Stopped");
    assert.equal(container.querySelector(".kikka-working-dots"), null);
    assert.equal(container.querySelector(".research-failure"), null, "an acknowledged Stop is not a task error");
    assert.match(container.querySelector(".research-conversation")!.textContent!, /costs already incurred still apply/);
    assert.match(container.querySelector(".burrow-result")!.textContent!, /Quote CAD 1,260/);
    for (const [raw, expected] of [
      ["Needs you: the comparison failed schema or literal evidence validation.", /couldn’t check the new result/],
      ["Needs you: the approved model budget is exhausted.", /approved work limit and paused/],
      ["Needs you: a paid request was interrupted. It will not be repeated.", /won’t repeat it automatically; it may already have cost money/],
      ["Kikka needs help confirming interrupted work. No new spending was authorized.", /lost confirmation/],
      ["Needs you: an instruction was interrupted. Confirm its saved state before continuing.", /couldn’t confirm whether your instruction arrived/],
      ["Unapproved model connection revoked", /paused without switching to another service/],
      ["SQLITE_INTERNAL some unrecognized backend diagnostic", /couldn’t continue.*saved work is still here/],
    ] as const) {
      view.unmount(); task = { ...task, state: "waiting", error: raw, version: task.version + 1 };
      agent = { ...agent, task, commands: [], agent: { ...agent.agent, phase: "review", activity: raw } };
      view = bundle.mod.mount(container, props()); await settle();
      assert.match(container.querySelector(".research-conversation")!.textContent!, expected);
      assert.match(container.querySelector('.research-notices [role="alert"]')!.textContent!, expected);
      assert.equal(container.querySelector(".kikka-working-dots"), null);
      assert.doesNotMatch(container.textContent!, /SQLITE_INTERNAL|schema|literal evidence|Unapproved model|safe boundary/);
      assert.equal(container.querySelector(".research-toolbar [role=status]")!.textContent, "Needs you");
      assert.match(container.querySelector(".burrow-result")!.textContent!, /Quote CAD 1,260/);
    }
    assert.equal(writes.length, 4, "translating saved statuses never sends or resumes work");
    view.unmount(); task = { ...task, state: "draft_ready", error: null };
    agent = { ...agent, task, commands: [["received", "steer", "Check quantity", "sent"]], agent: { ...agent.agent, phase: "finished" } };
    view = bundle.mod.mount(container, props()); await settle();
    assert.match(container.querySelector(".research-receipt")!.textContent!, /Sent to Kikka.*Delivery confirmed.*Read status isn’t available/);
    assert.doesNotMatch(container.querySelector(".research-receipt")!.textContent!, /Read by|Applied/);
    for (const [status, expected] of [[409, /has changed.*Refresh/], [500, /Couldn’t confirm your save.*edits are still here/]] as const) {
      view.unmount(); saveStatus = status; task = { ...task, state: "draft_ready", error: null };
      agent = { ...agent, task, agent: { ...agent.agent, phase: "finished", activity: "Ready" } };
      view = bundle.mod.mount(container, props()); await settle(); click("Edit result");
      const draft = container.querySelector<HTMLTextAreaElement>("#research-result")!;
      bundle.mod.act(() => { set.call(draft, "My unsaved result"); draft.dispatchEvent(new window.Event("input", { bubbles: true })); });
      click("Save edits"); await settle();
      assert.match(container.querySelector('[role="alert"]')!.textContent!, expected);
      assert.doesNotMatch(container.textContent!, /SQLITE_INTERNAL|backend diagnostic/);
      assert.equal(draft.value, "My unsaved result");
    }
    click("Cancel"); click("Edit");
    const correction = container.querySelector<HTMLTextAreaElement>(".burrow-context textarea")!;
    bundle.mod.act(() => { set.call(correction, "Delivery to Germany"); correction.dispatchEvent(new window.Event("input", { bubbles: true })); });
    click("Save correction"); await settle();
    assert.match(container.querySelector('.burrow-context [role="alert"]')!.textContent!, /don’t have permission/);
    assert.doesNotMatch(container.textContent!, /owner_id|backend diagnostic/);
    assert.equal(correction.value, "Delivery to Germany");
    view.unmount();
    const legacy = "Spotify US | Annual offer: unknown | 12 × monthly estimate: $12.99 × 12 = $155.88 (USD) | https://www.spotify.com/us/premium/ | captured 2026-10-20 UTC | e-us\n\nSpotify UK | Annual offer: unknown | 12 × monthly estimate: £12.99 × 12 = £155.88 (GBP) | https://www.spotify.com/uk/premium/ | captured 2026-10-21 UTC | e-uk";
    task = { ...task, result: legacy, manual_edited: false, proposed_result: "", version: task.version + 1 };
    agent = { ...agent, task, events: [{ seq: 5, type: "final_message", data: { content: legacy } }] };
    view = bundle.mod.mount(container, props()); await settle();
    assert.equal(container.querySelectorAll(".burrow-comparison tbody tr").length, 2);
    assert.match(container.querySelector("tbody")!.textContent!, /\$155.88 \(USD\)/);
    assert.match(container.querySelector("tbody")!.textContent!, /£155.88 \(GBP\)/);
    assert.match(container.querySelector(".burrow-comparison-note")!.textContent!, /not advertised annual plans/);
    assert.equal(container.querySelector(".burrow-comparison-original pre")!.textContent, legacy);
    assert.equal(container.querySelector(".burrow-comparison-sources")!.hasAttribute("open"), false);
    assert.equal(container.querySelector(".burrow-comparison-sources a")!.getAttribute("href"), "https://www.spotify.com/us/premium/");
    const writeCount = writes.length;
    for (const text of ["User-authored | notes, not a comparison", legacy.replace("https://www.spotify.com/us/premium/", "javascript:alert(1)")]) {
      view.unmount(); task = { ...task, result: text }; agent.task = task;
      view = bundle.mod.mount(container, props()); await settle();
      assert.equal(container.querySelector(".burrow-comparison"), null, "ambiguous text stays unchanged");
      assert.equal(container.querySelector(".burrow-document")!.textContent!.replace(/\n/g, ""), text.replace(/\n/g, ""));
      assert.equal(container.querySelector('a[href^="javascript:"]'), null);
    }
    view.unmount();
    const markdown = "## Plan comparison\n\n| Country | Plan | Currency | Price | Trial | Source |\n| --- | --- | --- | --- | --- | --- |\n| US | **Individual** | USD | $12.99 | First-time only | https://www.spotify.com/us/premium/ |\n| UK | <img src=x onerror=alert(1)> | GBP | £12.99 | unknown | [unsafe](javascript:alert(1)) |\n\n### Still unknown\n- Checkout tax";
    task = { ...task, result: markdown }; agent.task = task;
    view = bundle.mod.mount(container, props()); await settle();
    assert.equal(container.querySelectorAll(".burrow-saved-table thead th").length, 4);
    assert.equal(container.querySelectorAll(".burrow-saved-table tbody tr").length, 2);
    assert.equal(container.querySelector(".burrow-saved-table strong")!.textContent, "Individual");
    assert.match(container.querySelector(".burrow-saved-table details")!.textContent!, /Trial.*First-time only.*Source.*spotify.com/s);
    assert.equal(container.querySelector(".burrow-document img"), null);
    assert.equal(container.querySelector('a[href^="javascript:"]'), null);
    assert.match(container.querySelector(".burrow-document li")!.textContent!, /Checkout tax/);
    const copied: string[] = [];
    let clipboardFails = false;
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { if (clipboardFails) throw new Error("Denied"); copied.push(text); } } });
    const select = (node: Node) => bundle.mod.act(() => {
      (window.document.activeElement as HTMLElement)?.blur();
      const range = window.document.createRange(); range.selectNodeContents(node as never);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.document.dispatchEvent(new window.Event("selectionchange"));
    });
    const action = (label: string) => bundle.mod.act(() => {
      const button = [...window.document.querySelectorAll<HTMLButtonElement>('[aria-label="Selected text actions"] button')].find(b => b.textContent === label);
      assert.ok(button, label); button.click();
    });
    const selectedPlan = container.querySelector(".burrow-saved-table strong")!;
    select(selectedPlan as unknown as Node); action("Markdown"); await settle();
    assert.equal(copied.at(-1), "**Individual**", "a highlight inside bold text retains its Markdown formatting");
    action("Copy"); await settle(); assert.equal(copied.at(-1), "Individual");
    clipboardFails = true; action("Copy"); await settle();
    assert.match(window.document.querySelector('.burrow-selection-notice')!.textContent!, /Couldn’t copy.*browser’s Copy/);
    clipboardFails = false;
    select(container.querySelector(".burrow-saved-table table")! as unknown as Node); action("Markdown"); await settle();
    assert.match(copied.at(-1)!, /\| Country \| Plan \| Currency \| Price \|/);
    assert.match(copied.at(-1)!, /\| US \| \*\*Individual\*\* \| USD \| \$12.99 \|/);
    const quoteDraft = container.querySelector<HTMLTextAreaElement>("#research-instruction")!;
    bundle.mod.act(() => { set.call(quoteDraft, "My existing question"); quoteDraft.dispatchEvent(new window.Event("input", { bubbles: true })); });
    select(selectedPlan as unknown as Node); action("Quote"); await settle();
    assert.equal(quoteDraft.value, "My existing question\n\n> Individual\n\n");
    assert.equal(window.document.activeElement, quoteDraft);
    assert.equal(writes.length, writeCount, "quoting adds a draft, never a model request");
    select(selectedPlan as unknown as Node);
    bundle.mod.act(() => { quoteDraft.focus(); window.document.dispatchEvent(new window.Event("selectionchange")); });
    assert.equal(window.document.querySelector('[aria-label="Selected text actions"]'), null, "focusing an editor hides stale rendered-text selections");
    select(selectedPlan as unknown as Node); action("Remember"); await settle();
    const selectedMemory = container.querySelector<HTMLTextAreaElement>(".burrow-context textarea")!;
    assert.equal(selectedMemory.value, "Individual");
    assert.equal(container.querySelector<HTMLInputElement>('.burrow-context input[type="checkbox"]')!.checked, false, "project text never silently becomes a personal preference");
    assert.match(container.querySelector('.burrow-context [role="status"]')!.textContent!, /Nothing has been remembered yet/);
    select(container.querySelector(".burrow-document li")! as unknown as Node); action("Remember"); await settle();
    assert.equal(selectedMemory.value, "Individual", "another selection cannot overwrite an existing memory draft");
    assert.match(container.querySelector('.burrow-context [role="alert"]')!.textContent!, /draft is still here/);
    assert.equal(writes.length, writeCount, "Remember requires an explicit reviewed save");
    select(selectedPlan as unknown as Node);
    bundle.mod.act(() => window.document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Escape" })));
    assert.equal(window.document.querySelector('[aria-label="Selected text actions"]'), null);
    select(container.querySelector(".research-toolbar h1")! as unknown as Node);
    assert.equal(window.document.querySelector('[aria-label="Selected text actions"]'), null, "toolbar labels and app chrome are not selectable actions");
    click("Edit result");
    assert.equal(container.querySelector<HTMLTextAreaElement>("#research-result")!.value, markdown, "formatting leaves the exact saved text editable");
    select(container.querySelector("#research-result")! as unknown as Node);
    assert.equal(window.document.querySelector('[aria-label="Selected text actions"]'), null, "native editor selection remains untouched");
    click("Cancel");
    view.unmount(); task = { ...task, result: `\x60\x60\x60text\n${markdown}\n\x60\x60\x60` }; agent.task = task;
    view = bundle.mod.mount(container, props()); await settle();
    assert.equal(container.querySelector(".burrow-saved-table"), null, "tables inside a code block remain literal");
    assert.equal(writes.length, writeCount, "presentation does not rewrite or re-research saved answers");
  } finally {
    view!.unmount(); await bundle.cleanup(); await window.happyDOM.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("research workspace preserves candidate identity, decision basis and drafts without silently authorizing research", async () => {
  const window = new Window({ url: "http://localhost/burrow" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const task: BurrowTask = { id: "laptops", kind: "writing", format: "document", template: null, request: "Compare laptops", comparison: true, state: "draft_ready", result: "Original comparison", error: null, version: 4, created_at: 10, updated_at: 20 };
  const agent: BurrowAgent = { task, agent: { id: "same-goal", runtime_id: "runtime", phase: "finished", activity: "Comparison saved", max_cost_cents: 23 }, connected: true, commands: [], events: [], history: [] };
  const brief = { revision: 1, text: "Portable laptop for school", purchase_budget: "CAD 1200", created_at: 10 };
  let saved: ResearchWorkspace = { version: 1, brief, briefs: [brief], comparisons: [{ id: "comparison-1", requirements_revision: 1, created_at: 20, comparison: { title: "School laptops", requirements: [brief.text], options: [
    { id: "zinc", name: "Zinc 13", attributes: [{ label: "Weight", value: "1.2 kg", evidence_id: "capture-zinc", quote: "Weight: 1.2 kg", source_url: "https://example.com/zinc", captured_at: "2026-10-23T12:00:00Z" }], unknowns: ["Battery runtime"], sources: [], price: null },
    { id: "alder", name: "Alder 14", attributes: [], unknowns: ["Price", "Battery runtime"], sources: [], price: null },
  ] } }], candidates: [{ id: "zinc", name: "Zinc 13", note: "", shortlisted: false }, { id: "alder", name: "Alder 14", note: "", shortlisted: false }], contributions: [], decisions: [], activity: [] };
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  let rejectSave = false;
  const fetcher = async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== "GET") {
      const body = JSON.parse(String(init.body)); writes.push({ url, body });
      if (url.endsWith("/control")) return Response.json(task);
      assert.ok(url.endsWith("/research"));
      if (rejectSave || body.version !== saved.version) return new Response("Changed", { status: 409 });
      const change = body as ResearchChange;
      if (change.action === "candidate") saved.candidates = saved.candidates.map(c => c.id === change.candidate_id ? { ...c, note: change.note, shortlisted: change.shortlisted } : c);
      if (change.action === "brief") { saved.brief = { revision: saved.brief.revision + 1, text: change.text, purchase_budget: change.purchase_budget, created_at: 30 }; saved.briefs.push(saved.brief); }
      if (change.action === "decision") saved.decisions.push({ ...change, id: "choice", requirements_revision: 1, created_at: 25 });
      saved.version++; return Response.json(saved);
    }
    if (url.endsWith("/research")) return Response.json(saved);
    if (url.endsWith("/agent")) return Response.json(agent);
    if (url.includes("/context")) return Response.json({ memories: [], routines: [], history: [] });
    if (url.includes("/model-routing")) return Response.json({ catalog: [], roles: {}, preview: {}, connections: [] });
    throw new Error(`Unexpected read: ${url}`);
  };
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, sessionStorage: window.sessionStorage, fetch: fetcher, requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown, props: unknown) => { render: (props: unknown) => void; unmount: () => void } }>(join(fixtures, "researchTask.tsx"));
  const container = window.document.createElement("div"); window.document.body.append(container);
  let dirty = false;
  const props = { token: "owner", task, canRun: true, onUpdate() {}, onDirtyChange(value: boolean) { dirty = value; } };
  let view: ReturnType<typeof bundle.mod.mount>;
  const click = (text: string, root = container) => bundle.mod.act(() => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === text); assert.ok(b, text); b.click(); });
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  const fill = (selector: string, text: string) => bundle.mod.act(() => {
    const input = container.querySelector(selector)!;
    Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const option = (name: string) => [...container.querySelectorAll(".research-workspace .burrow-comparison > section")].find(s => s.querySelector("h3")?.textContent === name)! as typeof container;
  try {
    view = bundle.mod.mount(container, props); await settle();
    assert.equal(writes.length, 0);
    assert.match(option("Zinc 13").textContent!, /Weight: 1.2 kg.*Captured 2026-10-23T12:00:00Z/s);
    assert.match(option("Zinc 13").textContent!, /Still unknown: Battery runtime/);
    click("Order: research");
    assert.equal(container.querySelector('.research-workspace table tbody th')!.textContent, "Alder 14");
    click("Notes & shortlist", option("Zinc 13"));
    fill(".research-workspace-editor textarea", "I prefer this keyboard");
    bundle.mod.act(() => container.querySelector<HTMLInputElement>('.research-workspace-editor input[type="checkbox"]')!.click());
    assert.equal(dirty, true);
    click("Save to workspace"); await settle();
    assert.equal(writes.at(-1)!.body.candidate_id, "zinc", "sorting never changes the candidate being annotated");
    assert.equal(dirty, false);
    click("Shortlist (1)"); assert.equal(container.querySelectorAll('.research-workspace table tbody tr').length, 1);
    click("Choose this option", option("Zinc 13"));
    fill(".research-workspace-editor textarea", "The keyboard suits long writing sessions");
    click("Save to workspace"); await settle();
    assert.equal(writes.at(-1)!.body.comparison_id, "comparison-1");
    click("Brief"); click("Edit brief");
    fill(".research-workspace-editor textarea", "Battery life matters most now");
    rejectSave = true; saved.version++;
    click("Save to workspace"); await settle();
    assert.equal(container.querySelector<HTMLTextAreaElement>(".research-workspace-editor textarea")!.value, "Battery life matters most now");
    assert.equal(dirty, true);
    assert.match(container.querySelector('.research-workspace [role="alert"]')!.textContent!, /draft is still here/);
    rejectSave = false; click("Load latest for review"); await settle(); click("Save to workspace"); await settle();
    assert.equal(writes.filter(w => w.url.endsWith("/control")).length, 0, "saving requirements, notes and choices cannot dispatch work");
    assert.match(container.querySelector('.research-workspace [role="status"]')!.textContent!, /No research started/);
    click("Decision"); assert.match(container.querySelector(".research-decision")!.textContent!, /consider revisiting.*keyboard suits/s);
    assert.match(container.querySelector(".research-decision")!.textContent!, /Portable laptop for school/);
    const original = saved.comparisons[0];
    saved.comparisons.push({ ...original, id: "comparison-2", requirements_revision: 2, comparison: { ...original.comparison, title: "Updated research", options: [...original.comparison.options].reverse() } });
    saved.comparisons.push({ ...original, id: "late-old", comparison: { ...original.comparison, title: "Late old result" } }); saved.version++;
    view.unmount(); view = bundle.mod.mount(container, props); await settle();
    assert.match(container.querySelector('[aria-label="Saved comparisons"]')!.textContent!, /Updated research/);
    assert.doesNotMatch(container.querySelector('[aria-label="Saved comparisons"] > .burrow-comparison')!.textContent!, /Late old result/);
    assert.match(option("Zinc 13").textContent!, /On your shortlist.*I prefer this keyboard/s);
    assert.equal(writes.filter(w => w.url.endsWith("/control")).length, 0, "returning attaches without executing");
    // A later brief is saved separately from the existing allowance.
    saved = { ...saved, brief: { ...saved.brief, revision: 3, text: "Need a touchscreen" }, version: saved.version + 1 };
    view.unmount(); view = bundle.mod.mount(container, props); await settle(); click("Brief");
    click("Allow research update · brief 3"); await settle();
    assert.equal(writes.at(-1)!.body.requirements_revision, 3);
    assert.equal(writes.at(-1)!.body.action, "continue");
    assert.equal(writes.at(-1)!.body.allow_spending, true);
    assert.equal(writes.at(-1)!.body.max_cost_cents, undefined, "the update cannot reset the original allowance");
  } finally {
    view!.unmount(); await bundle.cleanup(); await window.happyDOM.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
