import type { Message } from "../api";

/** The open chat after catching up on what happened while this device was cut off (a
 *  reconnect, or a connection that fell behind). The server's latest page is the truth
 *  for the span it covers: new messages appear, edits show, deletions go. Anything older
 *  already on screen stays, and unsent messages stay at the end. */
export function catchUpMessages(
  current: readonly Message[],
  latest: readonly Message[],
  unsent: readonly Message[],
): Message[] {
  if (latest.length === 0) return [...unsent];
  const oldest = Math.min(...latest.map((m) => m.created_at));
  const unsentIds = new Set(unsent.map((m) => m.id));
  const older = current.filter((m) => !m._state && !unsentIds.has(m.id) && m.created_at < oldest);
  return [...older, ...latest, ...unsent];
}
