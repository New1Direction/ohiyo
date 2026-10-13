// "Add to calendar" writes an RFC 5545 file on the device: times in UTC, CRLF line ends,
// text escaped, long lines folded at 75 octets without splitting a character.
//   node --experimental-strip-types --test test/eventIcs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeIcsText, eventToIcs, icsFileName } from "../src/lib/eventIcs.ts";

const START = Date.UTC(2026, 9, 20, 3, 30) / 1000; // 20 Oct 2026 03:30 UTC
const STAMP = Date.UTC(2026, 9, 12, 12, 0, 5) / 1000;

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const lines = (ics: string) => unfold(ics).split("\r\n");

test("text is escaped the way calendars expect", () => {
  assert.equal(escapeIcsText("a\\b;c,d"), "a\\\\b\\;c\\,d");
  assert.equal(escapeIcsText("one\r\ntwo\nthree\rfour"), "one\\ntwo\\nthree\\nfour");
});

test("an event becomes one VEVENT with UTC times and a stable id", () => {
  const ics = eventToIcs(
    { id: "ev1", title: "Game night", starts_at: START, ends_at: START + 5400, description: null, location: "General (voice) · Gate HQ" },
    STAMP,
  );
  assert.ok(ics.endsWith("\r\n"), "ends with CRLF");
  assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
  const l = lines(ics);
  assert.equal(l[0], "BEGIN:VCALENDAR");
  assert.ok(l.includes("VERSION:2.0"));
  assert.ok(l.some((x) => x.startsWith("PRODID:")));
  assert.ok(l.includes("BEGIN:VEVENT") && l.includes("END:VEVENT"));
  assert.ok(l.includes("UID:ev1@ohiyo.gg"));
  assert.ok(l.includes("DTSTAMP:20261012T120005Z"));
  assert.ok(l.includes("DTSTART:20261020T033000Z"));
  assert.ok(l.includes("DTEND:20261020T050000Z"));
  assert.ok(l.includes("SUMMARY:Game night"));
  assert.ok(l.includes("LOCATION:General (voice) · Gate HQ"));
  assert.ok(!l.some((x) => x.startsWith("DESCRIPTION")), "no empty description");
  assert.equal(l[l.length - 2], "END:VCALENDAR");
});

test("an event with no end lasts an hour, and a cancelled one says so", () => {
  const l = lines(eventToIcs({ id: "e", title: "Quick", starts_at: START, cancelled: true }, STAMP));
  assert.ok(l.includes("DTEND:20261020T043000Z"));
  assert.ok(l.includes("STATUS:CANCELLED"));
});

test("titles and details are escaped inside the file", () => {
  const l = lines(
    eventToIcs({ id: "e", title: "Movies; snacks, drinks", description: "Bring:\n- chips\\dip", starts_at: START }, STAMP),
  );
  assert.ok(l.includes("SUMMARY:Movies\\; snacks\\, drinks"));
  assert.ok(l.includes("DESCRIPTION:Bring:\\n- chips\\\\dip"));
});

test("long lines fold at 75 octets and never split a character", () => {
  const title = "🎉".repeat(40) + " party at the place with a very long name";
  const ics = eventToIcs({ id: "e", title, starts_at: START }, STAMP);
  for (const raw of ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(raw).length <= 75, `too long: ${raw}`);
    assert.ok(!raw.includes("�"));
  }
  assert.ok(lines(ics).includes(`SUMMARY:${title}`), "unfolds back to the title");
});

test("the file name is a tidy slug", () => {
  assert.equal(icsFileName("Game night: Round 2!"), "game-night-round-2.ics");
  assert.equal(icsFileName("🎉🎉"), "event.ics");
});
