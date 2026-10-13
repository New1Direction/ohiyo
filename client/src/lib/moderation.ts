// Stub: the moderation tools' words and numbers (filled in by the change that adds them).
export const TIMEOUT_CHOICES: { seconds: number; label: string }[] = [];
export const SLOWMODE_CHOICES: { seconds: number; label: string }[] = [];
export const INVITE_EXPIRY_CHOICES: { seconds: number | null; label: string }[] = [];
export const INVITE_MAX_USES_CHOICES: { uses: number | null; label: string }[] = [];
export function slowmodeLabel(_seconds: number): string {
  return "";
}
export function slowmodeWait(_lastSentAt: number | null, _slowmodeSeconds: number, _now: number): number {
  return -1;
}
export function timeoutNotice(_until: number, _now: number, _locale?: string): string | null {
  return "";
}
export function inviteSummary(_invite: { expires_at: number | null; max_uses: number | null; uses: number }, _now: number): string {
  return "";
}
export function describeModAction(_entry: { action: string; metadata: string | null }): string {
  return "";
}
