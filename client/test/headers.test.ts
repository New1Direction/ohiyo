// O4: response headers for Cloudflare Pages (public/_headers, copied into dist by the
// build). The page's own <meta> CSP can't set frame-ancestors, so the header does. Calls
// need the microphone, camera and screen capture, so Permissions-Policy must not block them.
//   node --experimental-strip-types --test test/headers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Cloudflare's format: a URL pattern line, then indented "Name: value" lines.
function headersFor(pattern: string): Map<string, string> {
  const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (current === pattern && i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

test("every page is served with the hardening headers", () => {
  const h = headersFor("/*");
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.equal(h.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(h.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(h.get("permissions-policy"), "geolocation=(), payment=()");
});

test("the permissions policy leaves calls their microphone, camera and screen capture", () => {
  const policy = headersFor("/*").get("permissions-policy") ?? "";
  for (const feature of ["microphone", "camera", "display-capture"]) assert.ok(!policy.includes(feature), feature);
});
