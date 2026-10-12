// How a message's time reads: "Today at 9:23 AM", "Yesterday at 7:12 PM", or the date and
// time for anything older. "Today" and "yesterday" are the viewer's calendar days (in their
// time zone), worked out from calendar dates rather than by subtracting 24 hours, so they
// hold across midnight and on the days the clocks change.

/** Locale and time zone; both default to the viewer's own. Tests pin them. */
export type TimeOptions = { locale?: string; timeZone?: string };

type Kind = "day" | "clock" | "date" | "full";

// A chat formats many times; building an Intl formatter each time is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Whether the locale writes times with AM/PM (a 12-hour clock). */
function usesTwelveHourClock(opts: TimeOptions): boolean {
  return new Intl.DateTimeFormat(opts.locale, { hour: "numeric", timeZone: opts.timeZone })
    .formatToParts(new Date(0))
    .some((part) => part.type === "dayPeriod");
}

function build(kind: Kind, opts: TimeOptions): Intl.DateTimeFormat {
  const { locale, timeZone } = opts;
  if (kind === "day") return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  if (kind === "clock") {
    // "9:23 AM" where the clock is 12-hour; "09:23" where it is 24-hour.
    const hour = usesTwelveHourClock(opts) ? "numeric" : "2-digit";
    return new Intl.DateTimeFormat(locale, { hour, minute: "2-digit", timeZone });
  }
  if (kind === "date") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", timeZone });
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone });
}

function formatter(kind: Kind, opts: TimeOptions): Intl.DateTimeFormat {
  const key = `${kind}|${opts.locale ?? ""}|${opts.timeZone ?? ""}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const made = build(kind, opts);
  formatters.set(key, made);
  return made;
}

/** The calendar day a moment falls on in the given zone, as "YYYY-MM-DD". */
function dayKey(at: number, opts: TimeOptions): string {
  const parts = formatter("day", opts).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The day before a "YYYY-MM-DD" day, by the calendar alone. */
function dayBefore(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Just the time, the viewer's way: "9:23 AM" in en-US, "09:23" in en-GB. */
export function formatClockTime(at: number, opts: TimeOptions = {}): string {
  return formatter("clock", opts).format(new Date(at));
}

/** The time shown on a message: Today at…, Yesterday at…, or the date and the time. */
export function formatMessageTime(at: number, now: number = Date.now(), opts: TimeOptions = {}): string {
  const day = dayKey(at, opts);
  const today = dayKey(now, opts);
  const time = formatClockTime(at, opts);
  if (day === today) return `Today at ${time}`;
  if (day === dayBefore(today)) return `Yesterday at ${time}`;
  return `${formatter("date", opts).format(new Date(at))} ${time}`;
}

/** The full date and time, for hovering over a message's time. */
export function formatFullTime(at: number, opts: TimeOptions = {}): string {
  return formatter("full", opts).format(new Date(at));
}
