// Message formatting, the way Discord writes it: what the parser makes of a message before
// ChatPane draws it, and the timestamps it shows in the reader's own locale. Pure, so these
// run under plain node:
//   node --experimental-strip-types --test test/markdown.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatTimestamp,
  inlinePlainText,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from "../src/lib/markdown.ts";

const text = (t: string): Inline => ({ kind: "text", text: t });

test("bold, italic, underline and strikethrough", () => {
  assert.deepEqual(parseInline("**b** *i* __u__ ~~s~~"), [
    { kind: "bold", children: [text("b")] },
    text(" "),
    { kind: "italic", children: [text("i")] },
    text(" "),
    { kind: "underline", children: [text("u")] },
    text(" "),
    { kind: "strike", children: [text("s")] },
  ]);
});

test("three stars are bold and italic", () => {
  assert.deepEqual(parseInline("***both***"), [
    { kind: "bold", children: [{ kind: "italic", children: [text("both")] }] },
  ]);
});

test("underscores italicize words but leave snake_case alone", () => {
  assert.deepEqual(parseInline("_it_ snake_case_name"), [
    { kind: "italic", children: [text("it")] },
    text(" snake_case_name"),
  ]);
});

test("a star that opens on a space is just a star", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [text("2 * 3 * 4")]);
});

test("inline code keeps its contents as written", () => {
  assert.deepEqual(parseInline("`a*b*c` and ``one ` tick``"), [
    { kind: "code", text: "a*b*c" },
    text(" and "),
    { kind: "code", text: "one ` tick" },
  ]);
});

test("spoilers can hold formatting", () => {
  assert.deepEqual(parseInline("||secret **bold**||"), [
    { kind: "spoiler", children: [text("secret "), { kind: "bold", children: [text("bold")] }] },
  ]);
});

test("a backslash shows the next character as written", () => {
  assert.deepEqual(parseInline("\\*not italic\\* \\_nor this\\_"), [text("*not italic* _nor this_")]);
});

test("a masked link keeps its words and its real address", () => {
  assert.deepEqual(parseInline("[Ohiyo](https://ohiyo.gg)"), [
    { kind: "link", href: "https://ohiyo.gg/", children: [text("Ohiyo")], destinationHost: null },
  ]);
});

test("a masked link that names another site says where it really goes", () => {
  const [link] = parseInline("[paypal.com](https://evil.example/login)");
  assert.equal(link.kind, "link");
  assert.equal(link.kind === "link" && link.destinationHost, "evil.example");
});

test("a masked link to the site it names doesn't add the address", () => {
  const [link] = parseInline("[www.ohiyo.gg/docs](https://ohiyo.gg/docs)");
  assert.equal(link.kind === "link" && link.destinationHost, null);
});

test("only web addresses become links", () => {
  for (const bad of ["[click](javascript:alert(1))", "[x](data:text/html,hi)", "[x](ftp://a.b/c)", "[x](https://)"]) {
    assert.deepEqual(parseInline(bad), [text(bad)], bad);
  }
});

test("bare links stop before the punctuation after them", () => {
  assert.deepEqual(parseInline("see https://x.com/a."), [
    text("see "),
    { kind: "url", href: "https://x.com/a", text: "https://x.com/a" },
    text("."),
  ]);
});

test("formatting around a link keeps the link", () => {
  assert.deepEqual(parseInline("**https://x.com**"), [
    { kind: "bold", children: [{ kind: "url", href: "https://x.com/", text: "https://x.com" }] },
  ]);
});

test("custom emoji and timestamps are picked out", () => {
  assert.deepEqual(parseInline(":wave: <t:1700000000:R> <t:1700000000> <t:abc>"), [
    { kind: "emoji", name: "wave" },
    text(" "),
    { kind: "time", unix: 1700000000, style: "R" },
    text(" "),
    { kind: "time", unix: 1700000000, style: "f" },
    text(" <t:abc>"),
  ]);
});

test("a line break stays a line break", () => {
  assert.deepEqual(parseMarkdown("a\nb"), [{ kind: "paragraph", children: [text("a"), { kind: "br" }, text("b")] }]);
});

test("headings and subtext need the space after the marker", () => {
  assert.deepEqual(parseMarkdown("# Big\n## Mid\n### Small\n-# tiny\n#nospace"), [
    { kind: "heading", level: 1, children: [text("Big")] },
    { kind: "heading", level: 2, children: [text("Mid")] },
    { kind: "heading", level: 3, children: [text("Small")] },
    { kind: "subtext", children: [text("tiny")] },
    { kind: "paragraph", children: [text("#nospace")] },
  ]);
});

test("quote lines join into one quote, and formatting works inside", () => {
  assert.deepEqual(parseMarkdown("> quoted **x**\n> more\nafter"), [
    {
      kind: "quote",
      children: [{ kind: "paragraph", children: [text("quoted "), { kind: "bold", children: [text("x")] }, { kind: "br" }, text("more")] }],
    },
    { kind: "paragraph", children: [text("after")] },
  ]);
});

test("three arrows quote the rest of the message, and quotes don't nest", () => {
  assert.deepEqual(parseMarkdown("before\n>>> all\n> of this"), [
    { kind: "paragraph", children: [text("before")] },
    { kind: "quote", children: [{ kind: "paragraph", children: [text("all"), { kind: "br" }, text("> of this")] }] },
  ]);
});

test("lists, with one level of nesting", () => {
  const expected: Block[] = [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        { children: [text("a")], sublist: null },
        {
          children: [text("b")],
          sublist: { kind: "list", ordered: false, start: 1, items: [{ children: [text("b1")], sublist: null }] },
        },
        { children: [{ kind: "code", text: "c" }], sublist: null },
      ],
    },
  ];
  assert.deepEqual(parseMarkdown("- a\n* b\n  - b1\n- `c`"), expected);
});

test("numbered lists keep their first number", () => {
  assert.deepEqual(parseMarkdown("5. five\n6. six"), [
    {
      kind: "list",
      ordered: true,
      start: 5,
      items: [
        { children: [text("five")], sublist: null },
        { children: [text("six")], sublist: null },
      ],
    },
  ]);
});

test("a starred word at the start of a line is italic, not a list", () => {
  assert.deepEqual(parseMarkdown("*italic*"), [{ kind: "paragraph", children: [{ kind: "italic", children: [text("italic")] }] }]);
});

test("fenced code keeps its language and lines, without stray blank lines around it", () => {
  assert.deepEqual(parseMarkdown("before\n```js\nconst a = 1;\nconst b = 2;\n```\nafter"), [
    { kind: "paragraph", children: [text("before")] },
    { kind: "code", lang: "js", text: "const a = 1;\nconst b = 2;" },
    { kind: "paragraph", children: [text("after")] },
  ]);
  assert.deepEqual(parseMarkdown("```one line```"), [{ kind: "code", lang: null, text: "one line" }]);
});

test("an unclosed fence is shown as written", () => {
  assert.deepEqual(parseMarkdown("```oops"), [{ kind: "paragraph", children: [text("```oops")] }]);
});

test("nothing inside code is formatted", () => {
  assert.deepEqual(parseMarkdown("```\n# not a heading\n**not bold** https://x.com\n```"), [
    { kind: "code", lang: null, text: "# not a heading\n**not bold** https://x.com" },
  ]);
});

test("the plain text of a line is what the reader sees", () => {
  assert.equal(
    inlinePlainText(parseInline("**hi** [paypal.com](https://evil.example) `x`")),
    "hi paypal.com (evil.example) x"
  );
});

test("hostile input parses in linear time", () => {
  const inputs = [
    "*a".repeat(50_000),
    "**".repeat(30_000) + "x",
    "[".repeat(50_000),
    "[a](".repeat(20_000),
    "||".repeat(30_000) + "x",
    "_a ".repeat(30_000),
    "`".repeat(50_000),
    "> ".repeat(30_000),
    "- ".repeat(30_000),
    "<t:".repeat(30_000),
    "https://a.b/".repeat(10_000),
    "~~__**||".repeat(10_000),
  ];
  for (const input of inputs) {
    const started = performance.now();
    parseMarkdown(input);
    const ms = performance.now() - started;
    assert.ok(ms < 400, `${input.slice(0, 12)}… took ${ms.toFixed(0)} ms`);
  }
});

test("timestamps read in the reader's locale, in each of Discord's styles", () => {
  const at = 1_700_000_000; // Tuesday 14 November 2023, 22:13:20 UTC
  const opts = { now: at * 1000, locale: "en-US", timeZone: "UTC" };
  const shown = (style: Parameters<typeof formatTimestamp>[1]) => formatTimestamp(at, style, opts).replace(/ /g, " ");
  assert.equal(shown("t"), "10:13 PM");
  assert.equal(shown("T"), "10:13:20 PM");
  assert.equal(shown("d"), "11/14/2023");
  assert.equal(shown("D"), "November 14, 2023");
  assert.equal(shown("f"), "November 14, 2023 10:13 PM");
  assert.equal(shown("F"), "Tuesday, November 14, 2023 10:13 PM");
  const relative = (offsetSeconds: number) =>
    formatTimestamp(at, "R", { ...opts, now: (at + offsetSeconds) * 1000 });
  assert.equal(relative(2 * 3600), "2 hours ago");
  assert.equal(relative(-3 * 86400), "in 3 days");
  assert.equal(relative(30), "30 seconds ago");
  assert.equal(relative(-400 * 86400), "in 1 year");
  assert.equal(formatTimestamp(at, "D", { ...opts, locale: "de-DE" }), "14. November 2023");
});

test("a timestamp outside what a date can hold is left as written", () => {
  assert.deepEqual(parseInline("<t:99999999999999:R>"), [text("<t:99999999999999:R>")]);
});
