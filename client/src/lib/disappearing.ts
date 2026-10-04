// Disappearing-message durations: shared picker options + display helpers.

export const DISAPPEAR_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "Off", seconds: null },
  { label: "30 seconds", seconds: 30 },
  { label: "5 minutes", seconds: 5 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "8 hours", seconds: 8 * 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "1 week", seconds: 7 * 24 * 60 * 60 },
];

/** Compact label for a configured TTL, e.g. 3600 → "1h". */
export function formatDuration(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** Compact countdown to a future unix expiry, e.g. "4m", "59s", "2h". */
export function timeLeft(expiresAt: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, expiresAt - Math.floor(nowMs / 1000));
  if (s >= 86400) return `${Math.ceil(s / 86400)}d`;
  if (s >= 3600) return `${Math.ceil(s / 3600)}h`;
  if (s >= 60) return `${Math.ceil(s / 60)}m`;
  return `${s}s`;
}

/** The unix time a message disappears, for the decrypted-message cache: its expires_at
 *  when that is a real time, else null (never). Every cache write goes through this, so
 *  a disappearing message's plaintext is dropped when the message expires. */
export function messageExpiry(message: { expires_at?: number | null } | null | undefined): number | null {
  const at = message?.expires_at;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}
