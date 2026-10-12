// @mentions work for every username the sign-up form accepts (letters, numbers, dots,
// dashes and underscores). The rule, the same on the server (push) and in the app:
//   - a mention starts with "@" at the start of the text or after a space or line break, so
//     an email address is never a mention;
//   - its name is the run of username characters after the "@";
//   - a "." or "-" at the end of that run is punctuation ("thanks @alice."), unless the
//     whole run is the name in question (a name may itself end in a dot).
// test/fixtures/mention-cases.json holds the cases both sides are checked against.
//   node --experimental-strip-types --test test/mentions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { usernameProblem } from "../src/lib/authForm.ts";
import { activeMentionQuery, mentionsEveryone, mentionsUser, mentionsYou, splitMentions } from "../src/lib/mentions.ts";

type Case = { content: string; name: string; mentions: boolean; why: string };
const cases = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mention-cases.json"), "utf8"),
) as Case[];

test("the shared cases: whether a message mentions you", () => {
  for (const c of cases) {
    assert.equal(mentionsYou(c.content, c.name), c.mentions, `${c.why}: ${JSON.stringify(c.content)} for ${c.name}`);
  }
});

test("every name the sign-up form accepts can be mentioned, highlighted and completed", () => {
  for (const name of ["alice.b", "bob-c", "x_y", "Zed.9", "a-b.c_d"]) {
    assert.equal(usernameProblem(name, "register"), null, `${name} is a valid name`);
    assert.ok(mentionsUser(`hi @${name} there`, name), `${name} is mentioned`);
    assert.equal(splitMentions(`hi @${name} there`).find((s) => s.mention)?.mention, name, `${name} is highlighted`);
    const typed = `hi @${name}`;
    assert.equal(activeMentionQuery(typed, typed.length)?.query, name, `${name} is completed as it's typed`);
  }
});

test("a full stop after a name stays outside its highlight", () => {
  assert.deepEqual(splitMentions("thanks @alice."), [{ text: "thanks " }, { text: "@alice", mention: "alice" }, { text: "." }]);
  assert.deepEqual(splitMentions("see @bob-c, ok"), [{ text: "see " }, { text: "@bob-c", mention: "bob-c" }, { text: ", ok" }]);
});

test("an email address is not highlighted as a mention", () => {
  assert.equal(splitMentions("mail a@bc.de").some((s) => s.mention), false);
  assert.equal(splitMentions("mail sam@example.com").some((s) => s.mention), false);
});

test("@everyone and @here follow the same rule", () => {
  assert.ok(mentionsEveryone("@everyone."));
  assert.ok(mentionsEveryone("hey @here!"));
  assert.equal(mentionsEveryone("@everyone.else"), false);
});

test("the mention picker opens on a dotted or dashed name, and only after a space", () => {
  assert.deepEqual(activeMentionQuery("hi @al.b", 8), { query: "al.b", at: 3 });
  assert.deepEqual(activeMentionQuery("@bo-", 4), { query: "bo-", at: 0 });
  assert.equal(activeMentionQuery("mail a@b", 8), null);
});
