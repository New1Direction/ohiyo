// Calendar maths for Events, in the viewer's own time zone. Days are always built from a
// calendar date (year, month, day) and never by adding 24 hours, so a daylight-saving change
// can't repeat or skip a day.

/** An event as the calendar needs it: unix seconds. */
export type Timed = { starts_at: number; ends_at?: number | null };

/** With no end, an event counts as an hour long. */
export const DEFAULT_LENGTH_SECS = 60 * 60;

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar date of `d`, as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a day key. */
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The day `delta` days from `key` (negative goes back). */
export function moveDay(key: string, delta: number): string {
  const d = dateOfKey(key);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
}

/** The month `delta` months from (year, month); month is 0-11. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * The weeks of a month as local midnights, padded with the days around it to whole weeks.
 * `weekStartsOn` is 0 for Sunday, 1 for Monday.
 */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 0): Date[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => new Date(year, month, 1 - lead + w * 7 + i)),
  );
}

const byStart = <T extends Timed>(a: T, b: T) => a.starts_at - b.starts_at;

/** Events by the local day they start on, earliest first within a day. */
export function eventsByDay<T extends Timed>(events: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const ev of [...events].sort(byStart)) {
    const key = dayKey(new Date(ev.starts_at * 1000));
    out.set(key, [...(out.get(key) ?? []), ev]);
  }
  return out;
}

/** When an event is over, in unix seconds. */
export function endOf(ev: Timed): number {
  return ev.ends_at ?? ev.starts_at + DEFAULT_LENGTH_SECS;
}

/** What hasn't finished by `now`, grouped by the day it starts, earliest first. */
export function agenda<T extends Timed>(events: readonly T[], now: number): { key: string; events: T[] }[] {
  const upcoming = events.filter((ev) => endOf(ev) > now);
  return [...eventsByDay(upcoming)].map(([key, list]) => ({ key, events: list }));
}

/** The first day of the week for a locale (Monday in most of the world, Sunday in a few). */
export function weekStartFor(locale: string | undefined): 0 | 1 {
  try {
    const info = (new Intl.Locale(locale ?? "en-US") as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } });
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (firstDay === 1) return 1;
    if (firstDay === 7) return 0;
  } catch {
    // An unknown locale: fall through to the region guess.
  }
  return /-(US|CA|MX|BR|JP|KR|TW|IL|PH|IN)$/i.test(locale ?? "en-US") ? 0 : 1;
}

/** The viewer's language, when there's a navigator to ask. */
export function viewerLocale(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

/** "Tue, Oct 20, 7:00 – 9:00 PM" in the viewer's language and time zone. */
export function formatWhen(startsAt: number, endsAt: number | null | undefined, locale = viewerLocale()): string {
  const start = new Date(startsAt * 1000);
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (!endsAt) return fmt.format(start);
  const range = fmt as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
  return range.formatRange ? range.formatRange(start, new Date(endsAt * 1000)) : `${fmt.format(start)} – ${fmt.format(new Date(endsAt * 1000))}`;
}

/** Just the time of day: "7:00 PM". */
export function formatTime(unix: number, locale = viewerLocale()): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
}

/** A day's name in a list: "Today", "Tomorrow", or "Wednesday, October 14". */
export function dayLabel(key: string, todayKey: string, locale = viewerLocale()): string {
  if (key === todayKey) return "Today";
  if (key === moveDay(todayKey, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(dateOfKey(key));
}
