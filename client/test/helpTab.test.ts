// Settings → Help & feedback. Discord's support is one of its most common complaints; Ohiyo's
// answer starts with somewhere to go inside the app: the live service status, what's new, a
// prefilled bug report, questions and ideas, private security reports, the Terms and Privacy
// pages, and an honest note on getting back into an account.
//   node --experimental-strip-types --test test/helpTab.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Status = { ok: boolean; components?: { name: string; status: string }[] };
type Mod = {
  act: (callback: () => void) => void;
  mountHelpTab: (el: unknown, status: Status | "fail") => { unmount: () => void };
};

let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  const globals = {
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountHelpTab.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(status: Status | "fail") {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountHelpTab(container, status);
  // Let the status request settle and the tab re-render.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  bundle.mod.act(() => {});
  return {
    container,
    text: () => (container.textContent ?? "").replace(/\s+/g, " "),
    link: (label: string) =>
      [...container.querySelectorAll("a")].find((a) => (a.textContent ?? "").includes(label))?.getAttribute("href") ?? null,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("Help lists where to go: status, what's new, a bug report, questions, ideas, security, Terms and Privacy", async () => {
  const f = await mount({ ok: true });
  try {
    assert.equal(f.link("Service status"), "https://ohiyo.gg/status.html");
    assert.match(f.link("What's new") ?? "", /CHANGELOG\.md$/);
    const bug = f.link("Report a bug") ?? "";
    assert.ok(bug.startsWith("https://github.com/New1Direction/ohiyo/issues/new"), bug);
    assert.ok(new URL(bug).searchParams.get("body")?.includes("0.3.1"), "the report names the version");
    assert.ok(!bug.includes("secret-token"), "never the token from the home address");
    assert.equal(new URL(f.link("Ask a question") ?? "x:").searchParams.get("labels"), "question");
    assert.equal(new URL(f.link("Suggest an idea") ?? "x:").searchParams.get("labels"), "enhancement");
    assert.match(f.link("security") ?? "", /github\.com\/New1Direction\/ohiyo\/security/);
    assert.equal(f.link("Terms"), "https://ohiyo.gg/terms.html");
    assert.equal(f.link("Privacy"), "https://ohiyo.gg/privacy.html");
    assert.ok(f.text().includes("0.3.1"), "the version shows");
  } finally {
    f.done();
  }
});

test("the live status says all is well when every part is", async () => {
  const f = await mount({ ok: true, components: [{ name: "database", status: "ok" }] });
  try {
    assert.ok(f.text().includes("All systems normal"), f.text());
  } finally {
    f.done();
  }
});

test("a problem names the parts that aren't working", async () => {
  const f = await mount({ ok: false, components: [{ name: "database", status: "ok" }, { name: "voice", status: "degraded" }] });
  try {
    assert.ok(f.text().includes("voice"), f.text());
    assert.ok(!f.text().includes("All systems normal"));
  } finally {
    f.done();
  }
});

test("a failed status check says so plainly", async () => {
  const f = await mount("fail");
  try {
    assert.ok(f.text().includes("Couldn't check right now"), f.text());
  } finally {
    f.done();
  }
});

test("no contact email shows while none is set, and getting back in is explained honestly", async () => {
  const f = await mount({ ok: true });
  try {
    assert.equal(f.container.querySelectorAll('a[href^="mailto:"]').length, 0);
    const text = f.text();
    assert.ok(text.includes("Link a device"), "the way back in that exists today");
    assert.ok(/recovery code/i.test(text), "the recovery code for encryption keys");
    assert.ok(/can't reset/i.test(text), "no email reset, said plainly");
  } finally {
    f.done();
  }
});
