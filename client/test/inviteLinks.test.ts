// One reader for every way someone hands you an Ohiyo link: a bare invite code, an app link
// (?invite= or /invite/<code>), a desktop ohiyo:// link, or a one-time private DM link. The
// welcome screen, the "+" button's join box and desktop deep links all use it.
//   node --experimental-strip-types --test test/inviteLinks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSharedLink } from "../src/lib/inviteLinks.ts";

const invite = (code: string) => ({ kind: "invite", code });

test("a bare invite code is an invite, spaces around it ignored", () => {
  assert.deepEqual(parseSharedLink("daa596fqrut8"), invite("daa596fqrut8"));
  assert.deepEqual(parseSharedLink("  daa596fqrut8 \n"), invite("daa596fqrut8"));
});

test("an app link carries its invite in ?invite= or /invite/<code>", () => {
  assert.deepEqual(parseSharedLink("https://app.ohiyo.gg/?invite=daa596fqrut8"), invite("daa596fqrut8"));
  assert.deepEqual(parseSharedLink("https://app.ohiyo.gg/invite/daa596fqrut8"), invite("daa596fqrut8"));
  assert.deepEqual(parseSharedLink("app.ohiyo.gg/?invite=daa596fqrut8"), invite("daa596fqrut8"));
});

test("a desktop link opens the invite it names", () => {
  assert.deepEqual(parseSharedLink("ohiyo://invite/daa596fqrut8"), invite("daa596fqrut8"));
  assert.deepEqual(parseSharedLink("kikkacord://invite/daa596fqrut8"), invite("daa596fqrut8"));
  assert.deepEqual(parseSharedLink("ohiyo://daa596fqrut8"), invite("daa596fqrut8"));
});

test("a one-time private DM link is a DM link, not an invite", () => {
  assert.deepEqual(parseSharedLink("https://app.ohiyo.gg/?dm=tok_abc123"), { kind: "dm", token: "tok_abc123" });
  assert.deepEqual(parseSharedLink("https://app.ohiyo.gg/dm/tok_abc123"), { kind: "dm", token: "tok_abc123" });
});

test("anything else is refused", () => {
  for (const raw of [
    "",
    "   ",
    "not an invite!",
    "short",
    "https://example.com/",
    "https://app.ohiyo.gg/?invite=",
    "ohiyo://invite/",
    "ohiyo://invite/..%2F..%2Fetc",
    "https://app.ohiyo.gg/?invite=has%20space",
    `https://app.ohiyo.gg/?invite=${"a".repeat(65)}`,
    "a".repeat(65),
  ]) {
    assert.equal(parseSharedLink(raw), null, `refused: ${JSON.stringify(raw)}`);
  }
});
