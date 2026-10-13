// Catching up, like Discord: where the red "New messages" line goes when you open a chat with
// unread messages, and what the bar above the chat says.
//
// The unread count is the server's: messages from other people newer than your read mark. So
// the line sits above the oldest of the last `unread` messages from others; your own messages
// (sent, or still sending) don't count, wherever they fall.

export type MarkerMessage = { id: string; author: { id: string }; created_at: number };

/** The id of the first unread message; null when nothing is unread; "older" when it isn't
 *  loaded yet (the chat opens on its latest page). */
export function firstUnreadId(messages: readonly MarkerMessage[], unread: number, myId: string): string | null | "older" {
  if (unread <= 0) return null;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.author.id === myId || m.id.startsWith("temp-")) continue;
    seen += 1;
    if (seen === unread) return m.id;
  }
  return "older";
}

// Intl puts a narrow no-break space before AM/PM; the bar reads the same either way.
const plainSpaces = (s: string) => s.replace(/[  ]/g, " ");

/** "12 new messages since 3:12 PM", with the day when it isn't today ("since Oct 10 at
 *  6:30 PM"), or just the count when the first one's time isn't known. */
export function unreadBarLabel(
  count: number,
  since: number | null,
  nowMs: number,
  opts: { locale?: string; timeZone?: string } = {},
): string {
  const howMany = `${count} new message${count === 1 ? "" : "s"}`;
  if (since === null) return howMany;
  const { locale, timeZone } = opts;
  const at = new Date(since * 1000);
  const time = plainSpaces(new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(at));
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(d);
  if (dayOf(at) === dayOf(new Date(nowMs))) return `${howMany} since ${time}`;
  const day = plainSpaces(new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }).format(at));
  return `${howMany} since ${day} at ${time}`;
}
