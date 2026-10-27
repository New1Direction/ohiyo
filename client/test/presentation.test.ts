import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
import type { BurrowTask, PresentationExport, PresentationReview } from "../src/api.ts";
import type { PresentationSlide } from "../src/burrow/presentation.ts";

const window = new Window({ url: "http://localhost" }), document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<{ act: (cb: () => void) => void; mount: (el: unknown, task: BurrowTask) => () => void; presentationPptx: (v: PresentationExport) => Promise<Uint8Array>; presentationSlides: (f: string, s: string) => PresentationSlide[] }>;
const source = { title: "Teacher’s source", claim: "Water & air", url: "https://example.org/water?a=1&b=2", quote: "Water changes <state> & circulates.", checked: true };
const outline = "For the class — α 🌦\n## Slide 1: Water & air\nWater rises.\n**Speaker notes:** Ask about puddles.\n## Slide 2: Clouds\nDrops form.";
const task = { id: "presentation", kind: "writing", format: "document", state: "draft_ready", result: outline, proposed_result: "", version: 4, request: "Make a school presentation", coding: false } as BurrowTask;
let snapshot: PresentationReview;
let writes: Record<string, unknown>[] = [];
let lose = false;
const route = { connectionId: "teacher-api", providerModelId: "reviewer", endpoint: "https://example.org/v1/chat/completions", fundedBy: "you", maxOutputTokens: 1000, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 };
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init?: RequestInit) => {
      if (url.includes("model-routing")) return Response.json({ preview: { review: route } });
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); if (lose) throw new Error("Lost acknowledgement"); }
      return Response.json(snapshot);
    } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry(join(fixtures, "presentation.tsx"));
});
after(async () => { await bundle?.cleanup(); await window.happyDOM.close(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { await new Promise(r => setTimeout(r, 30)); bundle.mod.act(() => {}); };
async function mount(approved = false, version = 4) {
  snapshot = { version: 4, approved, review: { revision: 2, source_version: version, status: approved ? "approved" : "draft", audience: "Year 5", citations: [source], created_at: 0 }, history: [], evaluation: null };
  writes = []; lose = false;
  const container = document.createElement("div"); document.body.append(container);
  const unmount = bundle.mod.mount(container, task); await settle();
  return { container, button: (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text), close: () => { unmount(); container.remove(); } };
}
function texts(xml: string) { return [...new window.DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("a:t")].map(n => n.textContent).join("\n"); }

test("PowerPoint preserves ordered slides, introduction, Unicode, speaker notes, citations and audience in a real OOXML archive", async () => {
  const value: PresentationExport = { version: 4, format: "document", content: outline, audience: "Year 5", citations: [source] };
  const zip = await JSZip.loadAsync(await bundle.mod.presentationPptx(value));
  const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort();
  assert.equal(slides.length, 4);
  const content = await Promise.all(slides.map(async p => texts(await zip.file(p)!.async("string"))));
  assert.match(content[0], /For the class — α 🌦/); assert.match(content[1], /Water & air\nWater rises/); assert.match(content[2], /Clouds\nDrops form/);
  assert.match(content[3], /Teacher’s source/); assert.match(content[3], /Water changes <state> & circulates/); assert.match(content[3], /https:\/\/example.org\/water\?a=1&b=2/);
  const notes = texts(await zip.file("ppt/notesSlides/notesSlide2.xml")!.async("string"));
  assert.match(notes, /Ask about puddles/); assert.match(notes, /Audience: Year 5/); assert.match(notes, /\[1\] Teacher’s source/);
  assert.equal(zip.file("ppt/vbaProject.bin"), null, "no macros or executable page content");
});

test("long content paginates without losing asymmetric text or splitting Unicode", async () => {
  const body = "First\n" + "α🌦".repeat(1300) + "\nLast distinct sentence.";
  const zip = await JSZip.loadAsync(await bundle.mod.presentationPptx({ version: 1, format: "document", content: `## Slide 1: Long\n${body}`, audience: "Year 6", citations: [] }));
  const paths = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a,b) => Number(a.match(/(\d+)\.xml$/)![1])-Number(b.match(/(\d+)\.xml$/)![1]));
  assert.ok(paths.length > 2);
  const all = (await Promise.all(paths.map(async p => texts(await zip.file(p)!.async("string"))))).join("");
  assert.equal(all.match(/🌦/gu)?.length, 1300); assert.equal(all.match(/α/gu)?.length, 1300); assert.match(all, /Last distinct sentence/); assert.doesNotMatch(all, /�/u);
});

test("static page export retains quiz answers, explanations, all story paths, tables and supplied numbers; live simulations fail closed", async () => {
  const example = (name: string) => JSON.stringify({ page: JSON.parse(readFileSync(new URL(`../../server/src/api/burrow/examples/${name}.json`, import.meta.url), "utf8")).page });
  // The ready-made physics lesson also includes a live spring experiment.
  // A standalone quiz exports; a mixed simulation must fail rather than omit it.
  const quizPage = JSON.parse(example("quiz")).page;
  const quiz = bundle.mod.presentationSlides("creation", JSON.stringify({ page: { ...quizPage, spec: { root: "quiz", elements: { quiz: quizPage.spec.elements.quiz } } } }));
  assert.ok(quiz.some(s => /Answer: [A-D]\./.test(s.notes)));
  assert.equal(quiz.filter(s => /Answer:/.test(s.notes)).length, 3);
  assert.ok(quiz.some(s => s.notes.includes("2.45 cm")));
  for (const q of quizPage.spec.elements.quiz.props.questions) {
    assert.ok(quiz.some(s => s.title === q.question && s.notes.includes(q.explanation) && s.notes.includes(q.options[q.answer])));
  }
  const story = bundle.mod.presentationSlides("creation", example("story"));
  assert.ok(story.some(s => /→/.test(s.notes))); assert.ok(story.some(s => /Ending/.test(s.notes)));
  const storyPage = JSON.parse(example("story")).page;
  for (const element of Object.values(storyPage.spec.elements) as { type: string; props: { scenes?: { id: string; heading: string; text: string; choices: { label: string; next: string }[] }[] } }[]) {
    if (element.type !== "Story") continue;
    for (const scene of element.props.scenes!) {
      const slide = story.find(s => s.notes.startsWith(`Scene: ${scene.id}\n`));
      assert.ok(slide); assert.equal(slide.title, scene.heading); assert.equal(slide.text, scene.text);
      for (const choice of scene.choices) assert.ok(slide.notes.includes(`${choice.label} → ${choice.next}`));
    }
  }
  assert.throws(() => bundle.mod.presentationSlides("creation", example("quiz")), /cannot be faithfully exported/);
  assert.throws(() => bundle.mod.presentationSlides("creation", example("page")), /cannot be faithfully exported/);
  const table = { title:"Data",description:"Measured in class",theme:"forest",spec:{root:"r",elements:{r:{type:"Stack",props:{},children:["t","b"]},t:{type:"Table",props:{columns:["Place","Value"],rows:[{cells:["Left","17"]},{cells:["Right","3"]}]},children:[]},b:{type:"BarChart",props:{title:"Counts",bars:[{label:"Left",value:17},{label:"Right",value:3}]},children:[]}}}};
  const exported = bundle.mod.presentationSlides("creation",JSON.stringify({page:table}));
  assert.ok(exported.some(s=>s.text==="Place | Value\nLeft | 17\nRight | 3")); assert.ok(exported.some(s=>s.text==="Left: 17\nRight: 3"));
});

test("human sign-off and AI spending are independent; uncertain mutations lock actions and refresh never repeats them", async () => {
  const f = await mount();
  try {
    assert.equal(writes.length,0); assert.equal(f.button("Download PowerPoint"),undefined); assert.equal(f.button("Approve for school use")!.disabled,true);
    const ai = f.container.querySelector<HTMLDetailsElement>(".presentation-ai")!;
    bundle.mod.act(()=>{ai.open=true;ai.dispatchEvent(new window.Event("toggle"));}); await settle();
    assert.equal(f.button("Allow one AI review")!.disabled,true);
    const consent=[...f.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    bundle.mod.act(()=>consent.click()); await settle(); assert.equal(f.button("Allow one AI review")!.disabled,false);
    lose=true; bundle.mod.act(()=>f.button("Allow one AI review")!.click()); await settle();
    assert.equal(writes.length,1); assert.equal(writes[0].allow_evaluation,true); assert.equal(writes[0].max_cost_cents,10);
    assert.equal(f.button("Allow one AI review")!.disabled,true); assert.equal(f.button("Approve for school use")!.disabled,true);
    assert.match(f.container.textContent,/No action will repeat automatically/);
    lose=false; snapshot={...snapshot,evaluation:{id:"eval",version:1,state:"draft_ready",result:"Advisory: check source [1].",error:null,max_cost_cents:10}};
    bundle.mod.act(()=>f.button("Refresh review")!.click()); await settle();
    assert.equal(writes.length,1); assert.equal(f.button("Download PowerPoint"),undefined); assert.match(f.container.textContent,/not a fact check/);
  } finally {f.close();}
});

test("withdrawal needs confirmation, preserves history, and stale material resets source attestations", async () => {
  const f=await mount(true);
  try {
    bundle.mod.act(()=>f.button("Withdraw approval")!.click()); await settle(); assert.equal(writes.length,0);
    bundle.mod.act(()=>f.button("Keep approval")!.click()); await settle(); assert.equal(writes.length,0);
    bundle.mod.act(()=>f.button("Withdraw approval")!.click()); await settle();
    bundle.mod.act(()=>f.button("Confirm withdrawal")!.click()); await settle(); assert.equal(writes[0].action,"withdraw");
  } finally {f.close();}
  const stale=await mount(false,3);
  try { assert.match(stale.container.textContent,/Earlier sign-off does not cover this version/); assert.equal(stale.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false); }
  finally {stale.close();}
});

test("pasted school notes require an exact excerpt and render as escaped text without a bogus link", async () => {
  const f = await mount();
  const notes = "Class notes: Water changes <state> & circulates. <script>never execute</script>";
  function change(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    bundle.mod.act(() => {
      Object.getOwnPropertyDescriptor(field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  try {
    const select = f.container.querySelector<HTMLSelectElement>("select")!;
    bundle.mod.act(() => { select.value = "notes"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(f.container.querySelector('input[type="url"]'), null);
    const textarea = f.container.querySelector<HTMLTextAreaElement>('textarea[maxlength="8000"]')!;
    assert.equal(textarea.maxLength, 8000); assert.equal(f.button("Save review notes")!.disabled, true);
    change(textarea, "An unrelated note"); assert.equal(f.button("Save review notes")!.disabled, true);
    change(textarea, notes); assert.equal(f.button("Save review notes")!.disabled, false);
    assert.equal(f.container.querySelector('a[href=""]'), null);
    bundle.mod.act(() => f.button("Save review notes")!.click()); await settle();
    const citation = (writes[0].citations as { url: string; notes: string; checked: boolean }[])[0];
    assert.equal(citation.url, ""); assert.equal(citation.notes, notes); assert.equal(citation.checked, false);
    snapshot = { ...snapshot, approved: true, review: { ...snapshot.review!, status: "approved", citations: [{ ...source, url: "", notes }] } };
    bundle.mod.act(() => f.button("Refresh review")!.click()); await settle();
    const approved = f.container.querySelector('section[aria-label="Approved audience and sources"]')!;
    assert.equal(approved.querySelector("a"), null); assert.equal(approved.querySelector("script"), null);
    assert.match(approved.textContent!, /Saved school notes/); assert.ok(approved.textContent!.includes(notes));
  } finally { f.close(); }
});

test("PowerPoint labels saved school notes instead of an empty URL and preserves the supporting excerpt", async () => {
  const zip = await JSZip.loadAsync(await bundle.mod.presentationPptx({ version: 4, format: "document", content: "Water lesson", audience: "Year 5", citations: [{ ...source, url: "", notes: `Class notes: ${source.quote}` }] }));
  const slide = texts(await zip.file("ppt/slides/slide2.xml")!.async("string"));
  const notes = texts(await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string"));
  assert.match(slide, /Saved school notes/); assert.ok(slide.includes(source.quote));
  assert.match(notes, /Saved school notes/); assert.ok(notes.includes(`Supporting excerpt: ${source.quote}`));
});
