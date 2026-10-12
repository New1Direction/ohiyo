// Mentions start where the server says they do: at the start of the text or after whitespace
// by Rust's definition (char::is_whitespace). JavaScript's \s also counts U+FEFF, so before
// this an invisible character in front of @everyone pinged every app while the server
// (and the push relay) saw no mention.
//   node --experimental-strip-types --test test/mentionBoundary.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsEveryone, mentionsUser } from "../src/lib/mentions.ts";

test("an invisible character before the @ is not a word break, as on the server", () => {
  assert.equal(mentionsEveryone("﻿@everyone"), false);
  assert.equal(mentionsEveryone("​@here"), false);
  assert.equal(mentionsUser("﻿@sam hi", "sam"), false);
});

test("real whitespace still starts a mention", () => {
  assert.equal(mentionsEveryone("@everyone"), true);
  assert.equal(mentionsEveryone("line one\n@here"), true);
  assert.equal(mentionsEveryone("hi @here"), true, "a no-break space is whitespace on both sides");
  assert.equal(mentionsUser("hey @Sam!", "sam"), true);
});

test("a defused @everyone from a webhook pings nobody", () => {
  assert.equal(mentionsEveryone("@​everyone deploy finished"), false);
  assert.equal(mentionsEveryone("@​here"), false);
});
