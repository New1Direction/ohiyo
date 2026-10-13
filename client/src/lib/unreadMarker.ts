// Placeholder: where the "New messages" line goes and what the catch-up bar says.
export type MarkerMessage = { id: string; author: { id: string }; created_at: number };

export function firstUnreadId(_messages: readonly MarkerMessage[], _unread: number, _myId: string): string | null | "older" {
  return null;
}

export function unreadBarLabel(
  _count: number,
  _since: number | null,
  _nowMs: number,
  _opts?: { locale?: string; timeZone?: string },
): string {
  return "";
}
