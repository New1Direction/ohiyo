// What a formatted message looks like once drawn: the elements Discord's markdown turns into,
// links that are safe and honest about where they go, and timestamps in the reader's time.
// MessageContent is bundled with Vite and rendered with react-dom/server:
//   node --experimental-strip-types --test test/messageFormatting.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Emoji = { id: string; server_id: string; name: string; url: string; created_by: string; created_at: number };
type Mod = { renderMessageContent: (content: string, emojis?: Emoji[], me?: string, now?: number) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderMessageContent.tsx"));
});
after(async () => {
  await bundle?.cleanup();
});

const html = (content: string, emojis: Emoji[] = [], me = "") => bundle.mod.renderMessageContent(content, emojis, me, 1_700_000_000_000);

test("headings and subtext", () => {
  const out = html("# Big\n## Mid\n### Small\n-# tiny");
  assert.match(out, /<h1 class="kc-md-heading kc-md-h1">Big<\/h1>/);
  assert.match(out, /<h2 class="kc-md-heading kc-md-h2">Mid<\/h2>/);
  assert.match(out, /<h3 class="kc-md-heading kc-md-h3">Small<\/h3>/);
  assert.match(out, /<small class="kc-md-subtext">tiny<\/small>/);
});

test("inline styles", () => {
  const out = html("**b** *i* __u__ ~~s~~ `c`");
  assert.match(out, /<strong>b<\/strong>/);
  assert.match(out, /<em>i<\/em>/);
  assert.match(out, /<u>u<\/u>/);
  assert.match(out, /<s>s<\/s>/);
  assert.match(out, /<code class="kc-md-code">c<\/code>/);
});

test("quotes and lists", () => {
  assert.match(html("> said"), /<blockquote class="kc-md-quote">said<\/blockquote>/);
  const list = html("- a\n- b\n  - b1");
  assert.match(list, /<ul class="kc-md-list"><li>a<\/li><li>b<ul class="kc-md-list"><li>b1<\/li><\/ul><\/li><\/ul>/);
  assert.match(html("3. c\n4. d"), /<ol class="kc-md-list" start="3"><li>c<\/li><li>d<\/li><\/ol>/);
});

test("line breaks show", () => {
  assert.match(html("one\ntwo"), /one<br\/>two/);
});

test("a code block names its language and keeps its lines", () => {
  const out = html("```rust\nfn main() {}\nlet x = 1;\n```");
  assert.match(out, /<pre class="code-block" data-lang="rust"[^>]*><code>fn main\(\) \{\}\nlet x = 1;<\/code><\/pre>/);
});

test("a masked link opens in a new tab and shows its address on hover", () => {
  const out = html("[Ohiyo](https://ohiyo.gg)");
  assert.match(out, /<a href="https:\/\/ohiyo\.gg\/" title="https:\/\/ohiyo\.gg\/" target="_blank" rel="noopener noreferrer" class="kc-md-link">Ohiyo<\/a>/);
});

test("a masked link that names another site shows where it really goes", () => {
  assert.match(html("[paypal.com](https://evil.example/login)"), /paypal\.com<\/a><span class="kc-md-link-host"> \(evil\.example\)<\/span>/);
});

test("nothing but a web address ever becomes a link", () => {
  for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "javascript:alert(1)"]) {
    const out = html(bad);
    assert.doesNotMatch(out, /href="(?!https?:)/i, bad);
    assert.doesNotMatch(out, /<a /, bad);
  }
});

test("a timestamp is a <time> in the reader's locale, with the full date on hover", () => {
  const out = html("<t:1700000000:d>");
  assert.match(out, /<time class="kc-md-time" datetime="2023-11-14T22:13:20\.000Z" title="[^"]*2023[^"]*">/i);
});

test("spoilers, custom emoji, mentions and bare links still work", () => {
  const emoji: Emoji = { id: "e1", server_id: "s1", name: "wave", url: "/files/wave", created_by: "u", created_at: 0 };
  const out = html("||secret|| :wave: @sol https://x.com", [emoji], "sol");
  assert.match(out, /<button[^>]*data-spoiler=""[^>]*>secret<\/button>/);
  assert.match(out, /<img[^>]*alt=":wave:"/);
  assert.match(out, /<span[^>]*>@sol<\/span>/);
  assert.match(out, /<a[^>]*href="https:\/\/x\.com\/"[^>]*>https:\/\/x\.com<\/a>/);
});

test("formatting doesn't run inside code", () => {
  assert.match(html("`**not bold**`"), /<code class="kc-md-code">\*\*not bold\*\*<\/code>/);
});

test("forwarded messages and big emoji look as before", () => {
  assert.match(html("【FWD:sol】**hi**"), /Forwarded from <strong[^>]*>sol<\/strong>.*<strong>hi<\/strong>/s);
  assert.match(html("【BIG_EMOJI:🎉】"), /class="big-emoji-char"/);
});
