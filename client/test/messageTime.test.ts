// Message times read like a person says them: "Today at 9:23 AM", "Yesterday at 7:12 PM",
// and the date for anything older. "Today" and "yesterday" are the viewer's calendar days,
// so they hold across midnight and on the days the clocks change.
//   node --experimental-strip-types --test test/messageTime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClockTime, formatFullTime, formatMessageTime } from "../src/lib/messageTime.ts";

const NY = { locale: "en-US", timeZone: "America/New_York" };
// Intl puts a narrow no-break space before AM/PM; compare with plain spaces.
const plain = (s: string) => s.replace(/\s/g, " ");
const at = (iso: string) => new Date(iso).getTime();

test("a message from earlier today says Today at, with no leading zero on the hour", () => {
  const now = at("2026-10-12T15:00:00Z"); // 11:00 in New York
  assert.equal(plain(formatMessageTime(at("2026-10-12T13:23:00Z"), now, NY)), "Today at 9:23 AM");
});

test("a message from the day before says Yesterday at", () => {
  const now = at("2026-10-12T15:00:00Z");
  assert.equal(plain(formatMessageTime(at("2026-10-11T23:12:00Z"), now, NY)), "Yesterday at 7:12 PM");
});

test("an older message gives the date and the time, without a comma", () => {
  const now = at("2026-10-12T15:00:00Z");
  assert.equal(plain(formatMessageTime(at("2026-10-05T13:23:00Z"), now, NY)), "10/5/2026 9:23 AM");
});

test("midnight is the line between yesterday and today", () => {
  const now = at("2026-10-12T04:30:00Z"); // 00:30 on the 12th in New York
  assert.equal(plain(formatMessageTime(at("2026-10-12T03:59:00Z"), now, NY)), "Yesterday at 11:59 PM");
  assert.equal(plain(formatMessageTime(at("2026-10-12T04:00:00Z"), now, NY)), "Today at 12:00 AM");
});

test("today is the viewer's day, not the server's", () => {
  // The same moments, seen from Tokyo: the message is from the 12th, now is the 13th.
  const now = at("2026-10-12T15:00:00Z");
  const tokyo = { locale: "en-US", timeZone: "Asia/Tokyo" };
  assert.equal(plain(formatMessageTime(at("2026-10-11T23:12:00Z"), now, tokyo)), "Yesterday at 8:12 AM");
});

test("the day the clocks go forward is still one calendar day", () => {
  // 14 March 2027 has 23 hours in New York. Just after midnight on the 15th, a message from
  // 23:45 on the 13th is two days back, even though it is under 48 hours old.
  const now = at("2027-03-15T04:30:00Z"); // 00:30 EDT on the 15th
  assert.equal(plain(formatMessageTime(at("2027-03-14T04:45:00Z"), now, NY)), "3/13/2027 11:45 PM");
  assert.equal(plain(formatMessageTime(at("2027-03-14T05:30:00Z"), now, NY)), "Yesterday at 12:30 AM");
});

test("the day the clocks go back is still one calendar day", () => {
  // 1 November 2026 has 25 hours in New York.
  const now = at("2026-11-01T17:00:00Z"); // 12:00 EST
  assert.equal(plain(formatMessageTime(at("2026-11-01T05:30:00Z"), now, NY)), "Today at 1:30 AM");
  assert.equal(plain(formatMessageTime(at("2026-10-31T23:30:00Z"), now, NY)), "Yesterday at 7:30 PM");
});

test("the time follows the viewer's locale", () => {
  const now = at("2026-10-12T15:00:00Z");
  const london = { locale: "en-GB", timeZone: "Europe/London" };
  assert.equal(plain(formatMessageTime(at("2026-10-12T08:23:00Z"), now, london)), "Today at 09:23");
  assert.equal(plain(formatMessageTime(at("2026-10-05T08:23:00Z"), now, london)), "05/10/2026 09:23");
});

test("the clock time alone, for the later messages in a group", () => {
  assert.equal(plain(formatClockTime(at("2026-10-12T13:05:00Z"), NY)), "9:05 AM");
});

test("hovering shows the full date and time", () => {
  const full = plain(formatFullTime(at("2026-10-05T13:23:00Z"), NY));
  assert.match(full, /Monday, October 5, 2026/);
  assert.match(full, /9:23 AM/);
});
