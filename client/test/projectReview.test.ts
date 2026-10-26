import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();
let bundle: Bundle<{ act: (cb: () => void) => void; mount: (container: unknown) => () => void }>;
let snapshot: unknown;
let fail = false;
let writes: { action: string }[] = [];
before(async () => {
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); if (fail) throw new Error("Lost acknowledgement"); }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry(join(fixtures, "projectReview.tsx"));
});
after(async () => {
  await bundle?.cleanup(); await window.happyDOM.close();
  for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
});
const settle = async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 25));
  bundle.mod.act(() => {});
};
async function setup(value: unknown) {
  snapshot = value; writes = []; fail = false;
  const container = document.createElement("div"); document.body.append(container);
  const unmount = bundle.mod.mount(container); await settle();
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
  const click = async (text: string) => { assert.ok(button(text), text); bundle.mod.act(() => button(text).click()); await settle(); };
  return { container, button, click, cleanup: () => { unmount(); container.remove(); } };
}
const skill = { id: "skill", kind: "skill", base_revision: 2, content: JSON.stringify({ name: "Cite sources", description: "Check evidence", instructions: "Mark missing facts unknown." }), status: "pending", test_report: null };
const spec = { project: "School", revision: 2, content: "Six slides for year 5." };

test("stale proposals cannot approve; opening and canceling undo never sends a decision", async () => {
  const f = await setup({ spec, history: [{ revision: 2, proposal_id: "current", content: spec.content }], proposals: [
    { ...skill, id: "stale", kind: "spec", base_revision: 1, content: "Twenty slides" }, { ...skill, id: "current", kind: "spec", status: "approved", content: spec.content },
  ] });
  try {
    assert.equal(writes.length, 0);
    assert.equal(f.button("Use this plan").disabled, true);
    assert.match(f.container.textContent, /Out of date/);
    assert.equal(f.container.querySelector(".project-history")!.hasAttribute("open"), false, "past decisions start collapsed");
    await f.click("Undo approval"); assert.equal(writes.length, 0);
    await f.click("Keep approval"); assert.equal(writes.length, 0);
    await f.click("Undo approval"); await f.click("Confirm undo");
    assert.deepEqual(writes, [{ action: "rollback" }]);
  } finally { f.cleanup(); }
});

test("skill approval is not a test; uncertain outcomes lock actions until explicit refresh", async () => {
  const f = await setup({ spec, history: [], proposals: [skill] });
  try {
    assert.equal(f.button("Check helper"), undefined);
    assert.match(f.container.textContent, /Mark missing facts unknown/);
    fail = true; await f.click("Allow a check");
    assert.deepEqual(writes, [{ action: "approve" }]);
    assert.match(f.container.textContent, /Couldn’t confirm the outcome/);
    assert.equal(f.button("Allow a check").disabled, true);
    assert.equal(f.button("Decline").disabled, true);
    snapshot = { spec, history: [], proposals: [{ ...skill, status: "approved" }] }; fail = false;
    await f.click("Refresh");
    assert.equal(writes.length, 1, "refresh must only read the outcome");
    assert.ok(f.button("Check helper"));
    snapshot = { spec, history: [], proposals: [{ ...skill, status: "tested", test_report: "backend validator ERR_ACCESS_DENIED subprocess heap 32MiB" }] };
    await f.click("Check helper");
    assert.deepEqual(writes, [{ action: "approve" }, { action: "test" }]);
    assert.equal(f.button("Check helper"), undefined);
    assert.match(f.container.textContent, /Format check passed.*Accuracy and teaching quality.*not enabled/s);
    assert.doesNotMatch(f.container.textContent, /ERR_ACCESS_DENIED|subprocess|32MiB|base_revision/);
    assert.equal([...f.container.querySelectorAll("button")].some(b => /install|activate|retry/i.test(b.textContent)), false);
  } finally { f.cleanup(); }
});

test("an unknown or failed check never looks passed and never offers an automatic retry", async () => {
  for (const status of ["testing", "test_failed"]) {
    const f = await setup({ spec, history: [], proposals: [{ ...skill, status, test_report: "Raw worker diagnostic" }] });
    try {
      assert.equal(writes.length, 0);
      assert.ok(f.button("Undo approval"));
      assert.equal(f.button("Check helper"), undefined);
      assert.doesNotMatch(f.container.textContent, /Format check passed|Raw worker diagnostic/);
      assert.match(f.container.textContent, /won’t (run it again|repeat automatically)/);
    } finally { f.cleanup(); }
  }
});
