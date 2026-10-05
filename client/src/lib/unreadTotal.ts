// The unread map (chat id → count). Pure, for unit tests.

/** Total unread across every chat, as a whole number of at least zero. */
export function unreadTotal(unread: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(unread)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) total += Math.floor(count);
  }
  return total;
}

/** The map with one chat marked read. The same object when that chat had nothing unread. */
export function withoutUnread(unread: Record<string, number>, channelId: string): Record<string, number> {
  if (!unread[channelId]) return unread;
  const next = { ...unread };
  delete next[channelId];
  return next;
}
