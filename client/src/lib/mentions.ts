// @mention helpers — kept tiny and pure so they're easy to test/reuse.

/** Valid username characters for a mention token. */
const NAME = "[a-zA-Z0-9_]{2,32}";

/**
 * If the caret sits inside an open `@query` (start-of-line or after whitespace,
 * no spaces yet), return the query and the index of the `@`. Otherwise null.
 */
export function activeMentionQuery(
  value: string,
  caret: number
): { query: string; at: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([a-zA-Z0-9_]{0,32})$/);
  if (!m) return null;
  const query = m[1];
  return { query, at: caret - query.length - 1 };
}

/** Replace the open `@query` at `at..caret` with `@username ` and return the new value + caret. */
export function applyMention(
  value: string,
  at: number,
  caret: number,
  username: string
): { value: string; caret: number } {
  const insert = `@${username} `;
  const next = value.slice(0, at) + insert + value.slice(caret);
  return { value: next, caret: at + insert.length };
}

/** True if `content` mentions `username` as a whole `@token` (case-insensitive). */
export function mentionsUser(content: string, username: string): boolean {
  if (!username) return false;
  const re = new RegExp(`(?:^|\\s)@${escapeRe(username)}(?![a-zA-Z0-9_])`, "i");
  return re.test(content);
}

/** Split text into runs, marking `@username` tokens for pill rendering. */
export function splitMentions(text: string): { text: string; mention?: string }[] {
  const re = new RegExp(`@(${NAME})`, "g");
  const out: { text: string; mention?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    out.push({ text: m[0], mention: m[1] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
