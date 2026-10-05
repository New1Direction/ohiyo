// Which links in a message get a card under it. The list that renders the cards and the
// list that reserves room for them in the row are the same list: when they differed, a
// link written twice got two cards with room for one, and a link inside a code block got
// room with no card.
//   node --experimental-strip-types --test test/messageLinks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { linkCardUrls, trimUrlTail } from "../src/lib/messageLinks.ts";

const VIDEO = "https://youtu.be/dQw4w9WgXcQ";

test("each link gets one card, however many times it is written", () => {
  assert.deepEqual(linkCardUrls(`${VIDEO} ${VIDEO}`), [VIDEO]);
  assert.deepEqual(linkCardUrls(`look ${VIDEO} and again ${VIDEO}, and https://news.example/story`), [VIDEO, "https://news.example/story"]);
});

test("a link on both sides of a code span is still one card", () => {
  assert.deepEqual(linkCardUrls(`${VIDEO} \`code\` ${VIDEO}`), [VIDEO]);
});

test("links inside code get no card", () => {
  assert.deepEqual(linkCardUrls("```\ncurl https://api.example/v1\n```"), []);
  assert.deepEqual(linkCardUrls("run `curl https://api.example/v1` first"), []);
  assert.deepEqual(linkCardUrls(`\`\`\`\nhttps://a.example\nhttps://b.example\n\`\`\` then ${VIDEO}`), [VIDEO]);
});

test("a link hidden in a spoiler gets no card: the card would give it away", () => {
  assert.deepEqual(linkCardUrls(`the answer: ||${VIDEO}||`), []);
  assert.deepEqual(linkCardUrls(`||${VIDEO}|| but also https://news.example/story`), ["https://news.example/story"]);
});

test("punctuation around a link is not part of it", () => {
  assert.deepEqual(linkCardUrls(`watch this (${VIDEO}).`), [VIDEO]);
  assert.deepEqual(linkCardUrls(`<${VIDEO}>`), [VIDEO]);
  assert.deepEqual(linkCardUrls(`"${VIDEO}", she said`), [VIDEO]);
  assert.deepEqual(linkCardUrls(`is it ${VIDEO}?`), [VIDEO]);
  assert.equal(trimUrlTail(`${VIDEO}).`), VIDEO);
  assert.equal(trimUrlTail(`${VIDEO}>`), VIDEO);
  // A query string keeps its own punctuation.
  assert.equal(trimUrlTail("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s");
});

test("only web links count", () => {
  assert.deepEqual(linkCardUrls("javascript:alert(1) ftp://files.example/a mailto:a@b.example"), []);
  assert.deepEqual(linkCardUrls("no links here"), []);
  assert.deepEqual(linkCardUrls(""), []);
});

test("a forwarded message's cards come from the message, not from the forwarder's name", () => {
  assert.deepEqual(linkCardUrls(`【FWD:https://evil.example/name】hello ${VIDEO}`), [VIDEO]);
});
