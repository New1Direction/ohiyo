import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
let bundle: Bundle<{ renderServerSidebar: (activeHomeId?: string) => string }>;
const window = new Window();
before(async () => { bundle = await bundleEntry(join(fixtures, "renderServerSidebar.tsx")); });
after(async () => { await bundle?.cleanup(); await window.happyDOM.close(); });

test("Ohiyo home uses the existing logo while custom homes keep their initials", () => {
  for (const activeId of ["official", "custom"]) {
    window.document.body.innerHTML = bundle.mod.renderServerSidebar(activeId);
    const official = window.document.querySelector('[aria-label="Switch to Ohiyo"]')!;
    const custom = window.document.querySelector('[aria-label="Switch to Friends"]')!;
    assert.ok(official.querySelector('svg[aria-label="Ohiyo"] path'));
    assert.equal(official.textContent, "");
    assert.equal(custom.textContent, "FR");
    assert.equal(official.getAttribute("aria-pressed"), String(activeId === "official"));
    assert.equal(custom.getAttribute("aria-pressed"), String(activeId === "custom"));
  }
});
test("the lightning shortcut is removed without removing add-home, DMs or add-server", () => {
  window.document.body.innerHTML = bundle.mod.renderServerSidebar();
  assert.equal(window.document.body.textContent.includes("⚡"), false);
  assert.equal(window.document.querySelector('[aria-label="Create or manage Instant Servers"]'), null);
  for (const name of ["Add an Ohiyo server", "Direct Messages", "Add a server"]) {
    assert.ok(window.document.querySelector(`button[aria-label="${name}"]`));
  }
});
