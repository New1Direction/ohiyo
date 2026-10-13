// "Add to calendar": an RFC 5545 iCalendar file made on the device. Times are UTC, every
// line ends in CRLF, text is escaped, and lines longer than 75 octets are folded without
// splitting a character.

export type IcsEvent = {
  id: string;
  title: string;
  starts_at: number;
  ends_at?: number | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  cancelled?: boolean;
};

const MAX_OCTETS = 75;
const HOUR = 60 * 60;
const encoder = new TextEncoder();

/** Escape TEXT values: backslash, semicolon, comma, and every kind of line break. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function utc(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Fold a content line at 75 octets; continuation lines start with one space. */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    if (octets + size > limit) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** One event as a whole .ics file. `stamp` is when the file was made (unix seconds). */
export function eventToIcs(ev: IcsEvent, stamp: number, host = "ohiyo.gg"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ohiyo//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.id}@${host}`,
    `DTSTAMP:${utc(stamp)}`,
    `DTSTART:${utc(ev.starts_at)}`,
    `DTEND:${utc(ev.ends_at ?? ev.starts_at + HOUR)}`,
    `SUMMARY:${escapeIcsText(ev.title)}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.cancelled) lines.push("STATUS:CANCELLED");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A tidy file name for an event: lowercase words joined by dashes. */
export function icsFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "event"}.ics`;
}
