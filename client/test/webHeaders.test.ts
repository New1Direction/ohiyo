// The web app sends the same response headers wherever it is hosted: `public/_headers` is
// what Cloudflare Pages reads, `Caddyfile` is what the container image (Railway) serves
// with. A header changed in one and not the other would silently drop a protection on
// one host, so the two files must agree.
//   node --experimental-strip-types --test test/webHeaders.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function pagesHeaders(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(join(root, "public/_headers"), "utf8").split("\n")) {
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+?)\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function caddyHeaders(): Map<string, string> {
  const text = readFileSync(join(root, "Caddyfile"), "utf8");
  const block = text.match(/\n\theader \{\n([\s\S]*?)\n\t\}/);
  assert.ok(block, "the Caddyfile has a site-wide header block");
  const out = new Map<string, string>();
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s+([A-Za-z-]+)\s+"(.*)"\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

test("the container image sends every header Cloudflare Pages does, with the same value", () => {
  const pages = pagesHeaders();
  const caddy = caddyHeaders();
  assert.ok(pages.size >= 6, "public/_headers lists the security headers");
  for (const [name, value] of pages) {
    assert.equal(caddy.get(name), value, `${name} differs between public/_headers and Caddyfile`);
  }
});

test("neither host restricts the microphone, camera or screen capture (calls need them)", () => {
  for (const headers of [pagesHeaders(), caddyHeaders()]) {
    const policy = headers.get("Permissions-Policy") ?? "";
    for (const feature of ["microphone", "camera", "display-capture"]) {
      assert.equal(policy.includes(feature), false, `${feature} must not be restricted`);
    }
  }
});
