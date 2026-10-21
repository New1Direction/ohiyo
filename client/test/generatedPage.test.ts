import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { act: (fn: () => void) => void; parsePage: (value: unknown) => unknown; schema: unknown; mount: (element: unknown, value: unknown) => () => void };
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
    button("Keeping a regular wake-up time");
    assert.match(container.textContent!, /You got it/);
    button("Next question"); button("The number of dreams");
    assert.match(container.textContent!, /Not quite/);
    button("Next question"); button("Caffeine blocks");
    button("Next question"); button("Dark, quiet"); button("See my score");
    assert.match(container.textContent!, /3 out of 4/);
    button("Try again");
    assert.match(container.textContent!, /Question 1 of 4/);
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
  } finally { unmount(); container.remove(); }
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
