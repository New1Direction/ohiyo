// Message search reads the box like Discord: from:, mentions:, in:, has:, before:/after:/during:,
// pinned:, and the words left over. The server reads it with the same rule; both run the cases
// in fixtures/search-cases.json. While typing, the box suggests filters and their values.
//   node --experimental-strip-types --test test/searchQuery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySuggestion,
  highlightParts,
  parseSearch,
  suggestionsFor,
  type ParsedSearch,
  type SuggestionContext,
} from "../src/lib/searchQuery.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cases: { why: string; q: string; expect: Partial<ParsedSearch> }[] = JSON.parse(
  readFileSync(join(here, "fixtures", "search-cases.json"), "utf8"),
);

test("the search box reads the same as on the server", () => {
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const want: ParsedSearch = {
      text: [],
      from: [],
      mentions: [],
      in: [],
      has: [],
      before: null,
      after: null,
      during: null,
      pinned: null,
      ...c.expect,
    };
    assert.deepEqual(parseSearch(c.q), want, `${c.why}: ${JSON.stringify(c.q)}`);
  }
});

// Noon on 12 October 2026, in the machine's own time zone.
const NOON = new Date(2026, 9, 12, 12, 0, 0).getTime();
const ctx: SuggestionContext = {
  members: [
    { id: "u1", username: "alice", display_name: "Alice Doe" },
    { id: "u2", username: "albert.k", display_name: "Al" },
    { id: "u3", username: "bob", display_name: "Bobby" },
  ],
  channels: [{ name: "general" }, { name: "games" }, { name: "random" }],
  now: NOON,
};

const labels = (value: string, caret = value.length) => suggestionsFor(value, caret, ctx)?.items.map((i) => i.insert) ?? [];

test("an empty box offers every filter", () => {
  assert.deepEqual(labels(""), ["from:", "mentions:", "in:", "has:", "before:", "after:", "during:", "pinned:"]);
});

test("the start of a key offers the filters it could be", () => {
  assert.deepEqual(labels("fr"), ["from:"]);
  assert.deepEqual(labels("deploy b"), ["before:"]);
  assert.deepEqual(labels("hello"), [], "a word that starts no filter offers nothing");
});

test("from: and mentions: offer people by username or name", () => {
  assert.deepEqual(labels("from:"), ["from:alice ", "from:albert.k ", "from:bob "]);
  assert.deepEqual(labels("from:al"), ["from:alice ", "from:albert.k "]);
  assert.deepEqual(labels("mentions:bobb"), ["mentions:bob "], "matches the display name too");
  assert.deepEqual(labels("from:@ali"), ["from:alice "]);
  const first = suggestionsFor("from:", 5, ctx)!.items[0];
  assert.equal(first.label, "Alice Doe");
  assert.equal(first.detail, "alice");
  assert.equal(first.avatarOf, "u1");
});

test("in: offers channels, has: its kinds, pinned: true or false", () => {
  assert.deepEqual(labels("in:g"), ["in:general ", "in:games "]);
  assert.deepEqual(labels("in:#ran"), ["in:random "]);
  assert.deepEqual(labels("has:"), ["has:link ", "has:file ", "has:image ", "has:video ", "has:embed "]);
  assert.deepEqual(labels("has:im"), ["has:image "]);
  assert.deepEqual(labels("pinned:"), ["pinned:true ", "pinned:false "]);
});

test("dates suggest today and yesterday in the person's own day", () => {
  assert.deepEqual(labels("before:"), ["before:2026-10-12 ", "before:2026-10-11 "]);
  assert.deepEqual(labels("during:2026-10-1"), ["during:2026-10-12 ", "during:2026-10-11 "]);
});

test("the word under the caret is the one suggestions are for", () => {
  const s = suggestionsFor("from:al hello", 7, ctx)!;
  assert.deepEqual(s.items.map((i) => i.insert), ["from:alice ", "from:albert.k "]);
  assert.deepEqual([s.from, s.to], [0, 7]);
  assert.equal(suggestionsFor("from:al hello", 13, ctx), null, "hello starts no filter");
});

test("picking a suggestion replaces the word it was for", () => {
  const value = "deploy from:al";
  const s = suggestionsFor(value, value.length, ctx)!;
  assert.deepEqual(applySuggestion(value, s, s.items[0]), { value: "deploy from:alice ", caret: 18 });
  const mid = "from:al hello";
  const m = suggestionsFor(mid, 7, ctx)!;
  assert.deepEqual(applySuggestion(mid, m, m.items[1]), { value: "from:albert.k hello", caret: 14 });
});

test("matches are marked in any case, and the rest is left as it is", () => {
  assert.deepEqual(highlightParts("Deploy FAILED today", ["failed", "deploy"]), [
    { text: "Deploy", hit: true },
    { text: " ", hit: false },
    { text: "FAILED", hit: true },
    { text: " today", hit: false },
  ]);
  assert.deepEqual(highlightParts("nothing here", ["zzz"]), [{ text: "nothing here", hit: false }]);
  assert.deepEqual(highlightParts("a.b (c)", ["(c)"]), [
    { text: "a.b ", hit: false },
    { text: "(c)", hit: true },
  ]);
});
