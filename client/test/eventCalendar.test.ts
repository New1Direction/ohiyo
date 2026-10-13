// The Events calendar lays a month out in local days. Days are built from the calendar date
// (year, month, day), never by adding 24 hours, so a daylight-saving change can't repeat or
// skip a day, and month and year edges roll over.
//   node --experimental-strip-types --test test/eventCalendar.test.ts

// Pin a zone with daylight saving (each test file runs in its own process).
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";

import { agenda, dayKey, eventsByDay, monthGrid, moveDay, shiftMonth } from "../src/lib/eventCalendar.ts";

const keys = (weeks: Date[][]) => weeks.flat().map(dayKey);
const at = (y: number, m: number, d: number, h = 12, min = 0) => Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

test("a day key is the local calendar date", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

test("a month that starts on Sunday and has 28 days fills exactly four weeks", () => {
  const weeks = monthGrid(2026, 1); // February 2026
  assert.equal(weeks.length, 4);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(dayKey(weeks[0][0]), "2026-02-01");
  assert.equal(dayKey(weeks[3][6]), "2026-02-28");
});

test("a month is padded with the days around it to whole weeks", () => {
  const weeks = monthGrid(2026, 9); // October 2026 starts on a Thursday
  assert.equal(dayKey(weeks[0][0]), "2026-09-27");
  assert.equal(dayKey(weeks[0][4]), "2026-10-01");
  assert.equal(dayKey(weeks[weeks.length - 1][6]), "2026-10-31");
  const november = monthGrid(2026, 10); // starts on a Sunday, ends on a Monday
  assert.equal(dayKey(november[0][0]), "2026-11-01");
  assert.equal(dayKey(november[november.length - 1][6]), "2026-12-05");
});

test("the spring-forward month has every day once, each at local midnight", () => {
  const weeks = monthGrid(2026, 2); // DST starts 8 March 2026 in Los Angeles
  const days = keys(weeks);
  assert.equal(new Set(days).size, days.length, "no day twice");
  assert.ok(days.includes("2026-03-08") && days.includes("2026-03-09"));
  assert.ok(weeks.flat().every((d) => d.getHours() === 0 && d.getMinutes() === 0));
  for (let i = 1; i < days.length; i++) {
    assert.equal(moveDay(days[i - 1], 1), days[i], `${days[i - 1]} then ${days[i]}`);
  }
});

test("the fall-back month has every day once too", () => {
  const days = keys(monthGrid(2026, 10)); // DST ends 1 November 2026
  assert.equal(new Set(days).size, days.length);
  assert.equal(days.filter((k) => k.startsWith("2026-11")).length, 30);
});

test("weeks can start on Monday", () => {
  const weeks = monthGrid(2026, 1, 1);
  assert.equal(dayKey(weeks[0][0]), "2026-01-26");
  assert.equal(weeks[0][0].getDay(), 1);
});

test("moving by days and months rolls over month, year and clock-change edges", () => {
  assert.equal(moveDay("2026-03-07", 1), "2026-03-08");
  assert.equal(moveDay("2026-03-08", 1), "2026-03-09");
  assert.equal(moveDay("2026-03-31", 1), "2026-04-01");
  assert.equal(moveDay("2026-01-01", -1), "2025-12-31");
  assert.equal(moveDay("2026-10-29", 7), "2026-11-05");
  assert.equal(moveDay("2024-02-28", 1), "2024-02-29");
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
});

test("events land on the local day they start, earliest first", () => {
  const late = { id: "late", starts_at: at(2026, 2, 8, 23, 30) };
  const early = { id: "early", starts_at: at(2026, 2, 8, 1, 0) }; // before the 2am jump
  const next = { id: "next", starts_at: at(2026, 2, 9, 0, 15) };
  const byDay = eventsByDay([late, next, early]);
  assert.deepEqual(byDay.get("2026-03-08")?.map((e) => e.id), ["early", "late"]);
  assert.deepEqual(byDay.get("2026-03-09")?.map((e) => e.id), ["next"]);
});

test("the agenda lists what hasn't finished yet, grouped by day", () => {
  const now = at(2026, 9, 12, 18, 0);
  const done = { id: "done", starts_at: now - 7200, ends_at: now - 3600 };
  const live = { id: "live", starts_at: now - 600, ends_at: now + 3000 };
  const noEnd = { id: "noEnd", starts_at: now - 1800 }; // counts as an hour long
  const old = { id: "old", starts_at: now - 4 * 3600 };
  const tomorrow = { id: "tomorrow", starts_at: at(2026, 9, 13, 9, 0) };
  const groups = agenda([tomorrow, done, live, noEnd, old], now);
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(groups[0].events.map((e) => e.id), ["noEnd", "live"]);
  assert.deepEqual(groups[1].events.map((e) => e.id), ["tomorrow"]);
});
