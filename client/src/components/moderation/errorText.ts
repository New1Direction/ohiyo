/** What to tell someone when a moderation request fails: the server's own words when it
 *  sent a sentence (it says why, e.g. "that member ranks too high for you to act on"),
 *  otherwise the fallback. Starts with a capital and ends with a full stop. */
export function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message.trim() : "";
  if (!raw || raw.startsWith("{") || raw.startsWith("<") || /^HTTP \d+$/.test(raw) || raw.length > 200) return fallback;
  const sentence = raw.charAt(0).toUpperCase() + raw.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
