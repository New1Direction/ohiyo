import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures } from "./fixtures/bundle.ts";

test("private browser reconciles takeover with the same ID and leaves lost Give Back visibly uncertain without restarting work", async () => {
  const window = new Window({ url: "http://localhost/burrow" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const requests: { action: string; request_id: string; browser: { action: string; session_id?: string } }[] = [];
  let session: string | null = null;
  let takeovers = 0;
  let returned = false;
  const fetcher = async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith("/burrow/tasks/task/computer"));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-session");
    const body = JSON.parse(String(init.body)); requests.push(body);
    assert.equal(body.action, "browser_control");
    if (body.browser.action === "take_over") {
      session = body.request_id;
      if (++takeovers === 1) throw new Error("lost acknowledgement");
    }
    if (body.browser.action === "give_back") { returned = true; throw new Error("lost acknowledgement"); }
    return Response.json({ phase: returned || !session ? "agent" : "human", session_id: returned ? null : session, generation: 1, ...(body.browser.action === "frame" ? { png: "private-frame" } : {}) });
  };
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, fetch: fetcher })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown) => () => void }>(join(fixtures, "privateBrowser.tsx"));
  const container = window.document.createElement("div"); window.document.body.append(container);
  const unmount = bundle.mod.mount(container);
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const click = (label: string) => bundle.mod.act(() => {
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === label);
    assert.ok(button, label); button.click();
  });
  try {
    await settle(); click("Take Over"); await settle();
    assert.match(container.textContent!, /Take Over not yet confirmed/);
    click("Reconcile Take Over"); await settle();
    const takes = requests.filter(request => request.browser.action === "take_over");
    assert.equal(takes.length, 2); assert.equal(takes[0].request_id, takes[1].request_id);
    assert.match(container.textContent!, /You control the browser/);
    assert.ok(container.querySelector("img"));
    click("Give Back"); await settle();
    assert.match(container.textContent!, /Give Back not yet confirmed/);
    assert.equal(container.querySelector("img"), null);
    assert.equal(container.querySelector("input"), null);
    const give = requests.find(request => request.browser.action === "give_back")!;
    assert.equal(give.browser.session_id, takes[0].request_id);
    assert.notEqual(give.request_id, takes[0].request_id);
    click("Recheck browser status"); await settle();
    assert.match(container.textContent!, /Browser control is with Kikka/);
    assert.equal(requests.filter(request => request.browser.action === "give_back").length, 1);
  } finally {
    unmount(); await bundle.cleanup(); await window.happyDOM.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
