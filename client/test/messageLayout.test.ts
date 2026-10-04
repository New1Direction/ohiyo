// The chat list is virtualized, so every row's height is guessed from its text before it
// renders. A guess that assumes a wide pane gives a wrapped message on a phone a row that is
// too short, and it runs into the next one.
//   node --experimental-strip-types --test test/messageLayout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CHARS_PER_LINE,
  DEFAULT_ROW_METRICS,
  messageCharsPerLine,
  messageGroupTextPx,
  messageLineCount,
  messageRowMetrics,
} from "../src/lib/messageLayout.ts";

const phone = { listWidth: 390, fontScale: 1, isPhone: true };
const desktop = { listWidth: 968, fontScale: 1, isPhone: false };
const cozy = { lineHeight: 1.45, densityBasePx: 44 };

test("a phone-width chat fits far fewer characters per line than a desktop one", () => {
  const onPhone = messageCharsPerLine(phone);
  const onDesktop = messageCharsPerLine(desktop);
  assert.ok(onPhone >= 28 && onPhone <= 42, `phone: ${onPhone}`);
  assert.ok(onDesktop >= 100, `desktop: ${onDesktop}`);
});

test("a 44-character message is one line on desktop and two on a phone", () => {
  const text = "sol's surprises are always three hours long!";
  assert.equal(text.length, 44);
  assert.equal(messageLineCount(text, messageCharsPerLine(desktop)), 1);
  assert.equal(messageLineCount(text, messageCharsPerLine(phone)), 2);
});

test("bigger text fits fewer characters, and the count never collapses", () => {
  assert.ok(messageCharsPerLine({ ...desktop, fontScale: 1.25 }) < messageCharsPerLine(desktop));
  assert.ok(messageCharsPerLine({ listWidth: 120, fontScale: 1.25, isPhone: false }) >= 12);
});

test("the phone layout ignores the font-scale setting, as its stylesheet does", () => {
  assert.equal(messageCharsPerLine({ ...phone, fontScale: 1.25 }), messageCharsPerLine(phone));
  assert.equal(
    messageRowMetrics({ ...phone, ...cozy, fontScale: 1.25 }).linePx,
    messageRowMetrics({ ...phone, ...cozy }).linePx,
  );
});

test("before the list has been measured, the old 80-character guess is used", () => {
  assert.equal(DEFAULT_CHARS_PER_LINE, 80);
  assert.equal(messageCharsPerLine({ listWidth: 0, fontScale: 1, isPhone: false }), 80);
  assert.equal(messageCharsPerLine({ listWidth: Number.NaN, fontScale: 1, isPhone: false }), 80);
  assert.equal(messageCharsPerLine({ listWidth: 0, fontScale: 1.25, isPhone: false }), 64);
  assert.equal(DEFAULT_ROW_METRICS.charsPerLine, 80);
});

test("each line break starts a new line, and an empty message still takes one", () => {
  assert.equal(messageLineCount("one\ntwo\nthree", 80), 3);
  assert.equal(messageLineCount("", 80), 1);
  assert.equal(messageLineCount("a".repeat(170), 80), 3);
  assert.equal(messageLineCount("short\n" + "a".repeat(90), 80), 3);
});

test("wide characters take two columns each, so they wrap sooner", () => {
  // 30 CJK characters are as wide as 60 Latin ones.
  assert.equal(messageLineCount("好".repeat(30), 40), 2);
  assert.equal(messageLineCount("a".repeat(30), 40), 1);
  // An emoji is one wide character, not two UTF-16 units of ordinary width or more.
  assert.equal(messageLineCount("🎉".repeat(20), 40), 1);
  assert.equal(messageLineCount("🎉".repeat(21), 40), 2);
});

test("what fits on a line matches what a browser showed", () => {
  // Measured: 187 characters of ordinary English took two lines in 684px of 14px text,
  // and five lines in 328px of 15.68px text.
  const plan = "ok so the plan for saturday is: we meet at the station at ten, grab coffee, walk up to the lookout, and then whoever is still alive gets ramen after. bring a jacket, it gets cold up there";
  assert.equal(plan.length, 187);
  assert.equal(messageLineCount(plan, messageCharsPerLine({ listWidth: 768, fontScale: 1, isPhone: false })), 2);
  assert.equal(messageLineCount(plan, messageCharsPerLine(phone)), 5);
});

test("words wrap whole, and a long link moves to its own line before it breaks", () => {
  // "movie night?" fits on the first line; the 49-character link does not fit after it, so
  // it starts the second line and runs onto a third.
  const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s";
  assert.equal(link.length, 49);
  assert.equal(messageLineCount(`movie night? ${link}`, 41), 3);
  // Counting characters alone would say two.
  assert.equal(Math.ceil(`movie night? ${link}`.length / 41), 2);
  // Whole words: "aaaa bbbb cccc" in lines of 9 is "aaaa bbbb" then "cccc".
  assert.equal(messageLineCount("aaaa bbbb cccc", 9), 2);
  assert.equal(messageLineCount("aaaa bbbb cccc", 8), 3);
  // A word that exactly fills the line does not spill.
  assert.equal(messageLineCount("a".repeat(80), 80), 1);
});

test("the width of the text column is known, for cards that scale with it", () => {
  // Desktop: 16px padding each side, a 40px avatar and a 12px gap. Phone: 62px in all.
  assert.equal(messageRowMetrics({ ...desktop, ...cozy }).textWidth, 968 - 84);
  assert.equal(messageRowMetrics({ ...phone, ...cozy }).textWidth, 390 - 62);
  assert.equal(messageRowMetrics({ listWidth: 0, fontScale: 1, isPhone: false, ...cozy }).textWidth, 0);
});

test("a line of text is as tall as the stylesheet makes it", () => {
  // 0.875rem (14px) at line-height 1.45, and the phone's fixed 0.98rem (15.68px) at 1.45.
  assert.ok(Math.abs(messageRowMetrics({ ...desktop, ...cozy }).linePx - 20.3) < 0.01);
  assert.ok(Math.abs(messageRowMetrics({ ...phone, ...cozy }).linePx - 22.736) < 0.01);
  // Compact density, larger text.
  assert.ok(Math.abs(messageRowMetrics({ ...desktop, lineHeight: 1.25, densityBasePx: 38, fontScale: 1.25 }).linePx - 21.875) < 0.01);
});

// Measured in a browser (cozy density): a desktop row is 8px top padding + a 20px name line
// + 23.3px per one-line message + 2px gap. A phone row has 11.2px of top padding and 25.7px
// per one-line message.
const realDesktopRow = (messages: number) => 8 + 20 + 23.3 * messages + 2;
const realPhoneRow = (messages: number) => 11.2 + 20 + 25.74 * messages + 2;
const estimate = (metrics: { basePx: number; linePx: number }, messages: number) =>
  metrics.basePx + messageGroupTextPx(Array.from({ length: messages }, () => 1), metrics.linePx);

test("a group is never estimated shorter than it renders, however many messages it has", () => {
  const onDesktop = messageRowMetrics({ ...desktop, ...cozy });
  const onPhone = messageRowMetrics({ ...phone, ...cozy });
  for (const messages of [1, 2, 3, 6, 12, 40]) {
    assert.ok(estimate(onDesktop, messages) >= realDesktopRow(messages), `desktop, ${messages} message(s)`);
    assert.ok(estimate(onPhone, messages) >= realPhoneRow(messages), `phone, ${messages} message(s)`);
  }
});

test("the space left under a group is the same for short and long groups", () => {
  const onDesktop = messageRowMetrics({ ...desktop, ...cozy });
  const slack = (messages: number) => estimate(onDesktop, messages) - realDesktopRow(messages);
  assert.ok(Math.abs(slack(1) - slack(12)) < 1, `1: ${slack(1)}, 12: ${slack(12)}`);
  // A one-message group keeps the height it always had: 44 + 20.
  assert.ok(Math.abs(estimate(onDesktop, 1) - 64) < 0.5, String(estimate(onDesktop, 1)));
});
