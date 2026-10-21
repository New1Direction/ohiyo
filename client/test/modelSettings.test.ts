import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures } from "./fixtures/bundle.ts";

test("personal keys are write-only, blank edits preserve keys, and settings never dispatch inference", async () => {
  const window = new Window({ url: "http://localhost" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const subscriptionCalls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  let claude: Record<string, unknown> = { state: "disconnected", usableForResearch: false };
  let chatgpt: Record<string, unknown> = { state: "disconnected", usableForResearch: false };
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, fetch: async (url: string, init: RequestInit) => {
    if (url.includes("/burrow/subscriptions")) {
      subscriptionCalls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/chatgpt")) chatgpt = init.method === "POST" ? { state: "awaiting_sign_in", userCode: "ABCD-EFGHJ", authorizationUrl: "https://auth.openai.com/codex/device", usableForResearch: false } : { state: "disconnected", usableForResearch: false };
      else if (url.endsWith("/claude/code")) claude = { state: "verifying", attempt: "fixture-attempt", usableForResearch: false };
      else if (init.method === "POST") claude = { state: "awaiting_sign_in", attempt: "fixture-attempt", authorizationUrl: "https://claude.com/cai/oauth/authorize?fixture=true", usableForResearch: false };
      else if (init.method === "DELETE") claude = { state: "disconnected", usableForResearch: false };
      return Response.json(url.endsWith("/subscriptions") ? { claude, chatgpt } : url.endsWith("/chatgpt") ? chatgpt : claude);
    }
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response("{}", { status: 200 });
  } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const bundle = await bundleEntry<{ act: (fn: () => void) => void; mount: (el: unknown, props: unknown) => { unmount: () => void } }>(join(fixtures, "modelSettings.tsx"));
  const container = window.document.createElement("div"); window.document.body.append(container);
  const template = { id: "approved", name: "Approved", templateId: "approved", modelMapping: "*", active: true, priority: 0, scope: "ohiyo", hasKey: false };
  let refreshes = 0;
  const view = bundle.mod.mount(container, { token: "test-token", data: { catalog: [], roles: {}, preview: {}, connections: [template, { ...template, id: "mine", name: "Mine", scope: "personal", hasKey: true }] }, onRefresh: async () => { refreshes++; } });
  const click = (text: string) => bundle.mod.act(() => { const b = [...container.querySelectorAll("button")].find(b => b.textContent === text); assert.ok(b, text); b.click(); });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(calls.length, 0);
    click("Edit Mine");
    let key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    assert.equal(key.value, "");
    key.value = "dummy-key-for-unit-test";
    bundle.mod.act(() => { key.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(key.value, "", "clear the DOM input immediately on submit");
    await tick();
    assert.equal(calls[0].body.key, "dummy-key-for-unit-test");
    assert.equal(calls[0].body.templateId, "approved");
    assert.equal("hasKey" in calls[0].body, false);
    click("Edit Mine");
    key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    assert.equal(key.value, "");
    bundle.mod.act(() => { key.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await tick();
    assert.equal("key" in calls[1].body, false, "blank means preserve the saved key");
    assert.ok(calls.every(c => c.url.endsWith("/burrow/model-routing/connections")));
    assert.equal(refreshes, 2);
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    assert.doesNotMatch(container.textContent, /dummy-key-for-unit-test/);
    click("Add personal connection");
    assert.deepEqual([...container.querySelectorAll("select option")].map(o => o.getAttribute("value")), ["approved"], "personal connections cannot become templates");
    await tick();
    click("＋ Add connection");
    click("Claude Pro / Max");
    click("Continue with Claude"); await tick();
    assert.equal(container.querySelector('a[target="_blank"]')?.textContent, "Open Claude sign-in ↗");
    assert.match(container.textContent, /Connecting never starts a task/);
    assert.match(container.textContent, /No automatic switch to paid API keys/);
    assert.doesNotMatch(container.textContent, /research worker|subscription-backed execution|Sign-in pilot/);
    key = container.querySelector<HTMLInputElement>('.burrow-subscriptions input[type="password"]')!;
    key.value = "private-sign-in-fixture";
    bundle.mod.act(() => { key.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(key.value, ""); await tick();
    assert.deepEqual(subscriptionCalls.at(-1)?.body, { attempt: "fixture-attempt", code: "private-sign-in-fixture" });
    assert.match(container.textContent, /Checking sign-in/);
    assert.doesNotMatch(container.textContent, /private-sign-in-fixture/);
    claude = { state: "connected", email: "fixture@example.test", usableForResearch: true, models: [
      { id: "subscription/claude/claude-sonnet-5-5", providerModelId: "claude-sonnet-5-5", name: "Claude Sonnet" },
      { id: "subscription/claude/other", providerModelId: "other", name: "Another model" },
    ] };
    click("Refresh connections"); await tick();
    assert.match(container.textContent, /Signed in as fixture@example.test/);
    assert.equal(calls.length, 2, "sign-in never changes roles or executes work");
    click("Use for new research"); await tick();
    assert.ok(calls[2].url.endsWith("/model-routing/roles"));
    assert.deepEqual(calls[2].body, Object.fromEntries(["general", "research", "review", "summary"].map(r => [r, "subscription/claude/claude-sonnet-5-5"])));
    assert.match(container.textContent, /Existing tasks keep their approved connection/);
    assert.equal(refreshes, 3);
    click("Disconnect Claude"); await tick();
    click("Close"); click("＋ Add connection"); click("ChatGPT");
    click("Continue with ChatGPT"); await tick();
    assert.equal(container.querySelector('a[target="_blank"]')?.getAttribute("href"), "https://auth.openai.com/codex/device");
    assert.equal(container.querySelector(".burrow-device-code")?.textContent, "ABCD-EFGHJ");
    assert.equal(container.querySelector(".burrow-subscriptions input"), null, "Codex code belongs on OpenAI's page, not in Burrow");
    assert.match(container.textContent, /enable device-code login/);
    assert.match(container.textContent, /No automatic switch to paid API keys/);
    click("Cancel sign-in"); await tick();
    assert.equal(container.querySelector(".burrow-device-code"), null);
    assert.ok(subscriptionCalls.every(c => c.url.includes("/burrow/subscriptions")));
    assert.equal(window.localStorage.length, 0); assert.equal(window.sessionStorage.length, 0);
  } finally {
    view.unmount(); await bundle.cleanup(); await window.happyDOM.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
