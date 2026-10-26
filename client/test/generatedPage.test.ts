import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
import type { BurrowTask } from "../src/api.ts";

type Mod = { act: (fn: () => void) => void; parsePage: (value: unknown) => unknown; schema: unknown; mount: (element: unknown, value: unknown) => () => void; mountCreation: (element: unknown, task: BurrowTask, canRun?: boolean) => () => void };
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<Mod>;
const load = (name: string) => JSON.parse(readFileSync(new URL(`../../server/src/api/burrow/${name}`, import.meta.url), "utf8"));
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, requestAnimationFrame: (fn: () => void) => setImmediate(fn), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "generatedPage.tsx"));
});
after(async () => {
  await bundle?.cleanup(); await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  }
});

test("generated controls play, score asymmetric answers, branch, go back, and reset", () => {
  const container = document.createElement("div"); document.body.append(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent!.includes(text));
    assert.ok(found, `missing button ${text}`);
    bundle.mod.act(() => found.click());
  };
  let unmount = bundle.mod.mount(container, load("examples/quiz.json").page);
  try {
    button("The extension doubles");
    assert.match(container.textContent!, /You got it/);
    button("Next question"); button("It doubles to 19.6 N");
    assert.match(container.textContent!, /Not quite/);
    button("Next question"); button("2.45 cm"); button("See my score");
    assert.match(container.textContent!, /2 out of 3/);
    button("Try again");
    assert.match(container.textContent!, /Question 1 of 3/);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    bundle.mod.act(() => checkbox.click());
    assert.match(container.textContent!, /1 of 3 checked/);
    unmount();
    unmount = bundle.mod.mount(container, load("examples/story.json").page);
    const heading = container.querySelector(".gen-story h3")!.textContent;
    const firstChoice = container.querySelector<HTMLButtonElement>(".gen-story-choices button")!;
    bundle.mod.act(() => firstChoice.click());
    assert.notEqual(container.querySelector(".gen-story h3")!.textContent, heading);
    button("← Back");
    assert.equal(container.querySelector(".gen-story h3")!.textContent, heading);
    bundle.mod.act(() => container.querySelector<HTMLButtonElement>(".gen-story-choices button")!.click());
    button("Start over");
    assert.equal(container.querySelector(".gen-story h3")!.textContent, heading);
    for (const [choices, ending] of [
      [["Follow the grease", "Take the brace"], "Not a thief. A missing pair of hands."],
      [["Ask Mara", "Take the lamp"], "A different landing"],
      [["Ask Mara", "Close the harbour and stay"], "Company at the sluice"],
      [["Raise the closure flag"], "A safe delay, an unanswered question"],
    ] as const) {
      for (const choice of choices) button(choice);
      assert.equal(container.querySelector(".gen-story h3")!.textContent, ending);
      assert.equal(container.querySelectorAll(".gen-story-choices button").length, 0);
      button("Start over");
    }
  } finally { unmount(); container.remove(); }
});

test("spring controls balance weight, scale extension by stiffness, and reset", () => {
  const container = document.createElement("div"); document.body.append(container);
  const unmount = bundle.mod.mount(container, load("examples/quiz.json").page);
  const set = (label: string, value: string) => {
    const field = [...container.querySelectorAll("label")].find(item => item.textContent!.startsWith(label))!;
    const input = document.getElementById(field.htmlFor) as unknown as HTMLInputElement;
    bundle.mod.act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const readouts = () => [...container.querySelectorAll("dd")].map(item => item.textContent!.trim());
  try {
    assert.deepEqual(readouts(), ["9.8 N", "9.8 cm"]);
    set("Spring stiffness", "200");
    assert.deepEqual(readouts(), ["9.8 N", "4.9 cm"]);
    set("Hanging mass", "0.5");
    assert.deepEqual(readouts(), ["4.9 N", "2.45 cm"]);
    set("Spring stiffness", "50"); set("Hanging mass", "2");
    assert.deepEqual(readouts(), ["19.6 N", "39.2 cm"]);
    set("Hanging mass", "0");
    assert.deepEqual(readouts(), ["0 N", "0 cm"]);
    bundle.mod.act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reset")!.click());
    assert.deepEqual(readouts(), ["9.8 N", "9.8 cm"]);
  } finally { unmount(); container.remove(); }
});

test("web journey changes DNS behavior without skipping the server, and can restart", () => {
  const container = document.createElement("div"); document.body.append(container);
  const unmount = bundle.mod.mount(container, load("examples/page.json").page);
  const click = (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent!.includes(text));
    assert.ok(button, text);
    bundle.mod.act(() => button.click());
  };
  try {
    click("DNS");
    const detail = container.querySelector('[aria-live="polite"]')!;
    assert.match(detail.textContent!, /device asks a DNS resolver/);
    bundle.mod.act(() => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
    assert.match(detail.textContent!, /without asking a DNS resolver again/);
    click("Next step");
    assert.match(detail.textContent!, /new connection in both scenarios/);
    click("Next step");
    assert.match(detail.textContent!, /browser sends an HTTP request/);
    click("Next step");
    assert.match(detail.textContent!, /Bytes become a page/);
    click("Start again");
    assert.match(detail.textContent!, /STEP 1 OF 5/);
    assert.equal(container.querySelectorAll('button[aria-pressed="true"]').length, 1);
    click("DNS");
    bundle.mod.act(() => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click());
    assert.match(detail.textContent!, /device asks a DNS resolver/);
  } finally { unmount(); container.remove(); }
});

test("interactive pages and a single composer stay together; typing preserves play progress and disconnected AI stays off", () => {
  const container = document.createElement("div"); document.body.append(container);
  const task: BurrowTask = { id: "study", kind: "writing", format: "creation", template: null, coding: false, request: "Help me study", state: "draft_ready", error: null, version: 1, created_at: 0, updated_at: 0, result: JSON.stringify({ ...load("examples/quiz.json"), messages: [], can_undo: false, example: true }) };
  const button = (text: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent!.startsWith(text));
    assert.ok(found, `missing button ${text}`);
    bundle.mod.act(() => found.click());
  };
  let unmount = bundle.mod.mountCreation(container, task);
  try {
    const preview = container.querySelector<HTMLElement>('[aria-label="Interactive page"]')!;
    assert.ok(preview);
    assert.equal(container.querySelectorAll("textarea").length, 1);
    assert.equal(container.querySelector('[aria-label="Messages"]')!.contains(preview), true);
    const answer = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent!.includes("The extension doubles"))!;
    bundle.mod.act(() => answer.click());
    assert.match(preview.textContent!, /You got it/);
    button("Next question");
    const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
    bundle.mod.act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep my notes\nAdd a recap");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    bundle.mod.act(() => preview.querySelector("summary")!.click());
    assert.match(preview.textContent!, /Question 2 of 3/);
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep my notes\nAdd a recap");
    assert.equal([...container.querySelectorAll("button")].find(b => b.type === "submit")!.disabled, true);
    assert.match(container.querySelector("form")!.textContent!, /AI page creation isn’t available/, "the disabled reason stays beside the composer");
    unmount();
    unmount = bundle.mod.mountCreation(container, { ...task, state: "waiting", result: JSON.stringify({ page: null, messages: [{ role: "user", text: task.request }], can_undo: false, example: false }) });
    assert.equal(container.querySelector('[aria-label="Interactive page"]'), null);
    assert.match(container.querySelector('[aria-label="Messages"]')!.textContent!, /Help me study/);
    assert.equal([...container.querySelectorAll("button")].find(b => b.type === "submit")!.disabled, true);
  } finally { unmount(); container.remove(); }
});

test("page chat sends only on consent, retains a denied revision and restores the previous page on Undo", async () => {
  const originalFetch = globalThis.fetch;
  const writes: { allow_generation?: boolean; instruction?: string; version: number; action?: string }[] = [];
  const container = document.createElement("div"); document.body.append(container);
  const initial = load("examples/page.json");
  const restored = { ...initial.page, title: "Original classroom page" };
  const task: BurrowTask = { id: "page-chat", kind: "writing", format: "creation", template: null, coding: false, request: "Explain a web request", state: "waiting", error: null, version: 1, created_at: 0, updated_at: 0, result: JSON.stringify({ page: null, messages: [{ role: "user", text: "Explain a web request" }], can_undo: false, example: false }) };
  let denied = false;
  globalThis.fetch = async (_url, init) => {
    writes.push(JSON.parse(String(init!.body)));
    if (denied && writes.at(-1)!.action !== "undo") return new Response("Permission denied", { status: 403 });
    const undo = writes.at(-1)!.action === "undo";
    return Response.json({ ...task, version: undo ? 4 : 2, state: "draft_ready", result: JSON.stringify({ ...initial, page: undo ? restored : initial.page, messages: [{ role: "user", text: task.request }, { role: "helper", text: undo ? "Restored your page." : initial.reply }], can_undo: !undo, example: false }) });
  };
  const unmount = bundle.mod.mountCreation(container, task, true);
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent!.startsWith(text))!;
  const input = container.querySelector("textarea")!;
  const type = (text: string) => bundle.mod.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  try {
    await settle(); assert.equal(writes.length, 0);
    bundle.mod.act(() => button("Allow & create").click()); await settle();
    assert.deepEqual(writes, [{ allow_generation: true, version: 1 }]);
    assert.equal(container.querySelector('.generated-page h1')!.textContent, initial.page.title);
    denied = true; type("Add a class question");
    assert.equal(button("Undo change").disabled, true, "undo must not discard unsent text");
    bundle.mod.act(() => button("Send").click()); await settle();
    assert.equal(input.value, "Add a class question");
    assert.equal(container.querySelector('.generated-page h1')!.textContent, initial.page.title);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /permission/i);
    await settle(); assert.equal(writes.length, 2, "denial never auto-retries");
    type(""); bundle.mod.act(() => button("Undo change").click()); await settle();
    assert.equal(container.querySelector('.generated-page h1')!.textContent, restored.title);
    assert.equal(button("Undo change").disabled, true);
  } finally { unmount(); container.remove(); globalThis.fetch = originalFetch; }
});

test("the shared page contract rejects executable content, invalid graphs and invalid answers", () => {
  assert.deepEqual(bundle.mod.schema, load("catalog.schema.json"), "regenerate server schema with bun scripts/burrow-catalog.ts");
  for (const name of ["quiz", "story", "page"]) assert.doesNotThrow(() => bundle.mod.parsePage(load(`examples/${name}.json`).page));
  const unsafe = [
    (p: any) => { p.spec.elements.intro.type = "script"; },
    (p: any) => { p.spec.elements.intro.on = { press: { action: "fetch" } }; },
    (p: any) => { p.spec.elements.intro.props.text = { $state: "/secret" }; },
    (p: any) => { p.spec.elements.root.children = ["root"]; },
    (p: any) => { p.spec.elements.root.children.push("intro"); },
    (p: any) => { p.spec.elements.quiz.props.questions[0].answer = 3; },
    (p: any) => { p.spec.elements.lab.props = { html: "<script>alert(1)</script>" }; },
    (p: any) => { p.spec.elements.lab = { type: "RequestJourney", props: { url: "https://example.com" }, children: [] }; },
  ];
  for (const mutate of unsafe) {
    const page = load("examples/quiz.json").page; mutate(page);
    assert.throws(() => bundle.mod.parsePage(page));
  }
  const page = load("examples/quiz.json").page;
  page.title = '<img src=x onerror="alert(1)">';
  const container = document.createElement("div");
  const unmount = bundle.mod.mount(container, page);
  try { assert.equal(container.querySelector("img"), null); assert.ok(container.textContent!.includes("<img src=x")); }
  finally { unmount(); }
});
