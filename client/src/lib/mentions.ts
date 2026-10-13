// @mention helpers — kept tiny and pure so they're easy to test/reuse.
//
// The rule, the same as the server's push relay (server/src/api/notifications.rs):
//   - a mention starts with "@" at the start of the text or after whitespace, so an email
//     address is never one. Whitespace as the server counts it (Rust's char::is_whitespace),
//     which isn't JavaScript's \s: that also counts U+FEFF and leaves out U+0085, so an
//     invisible character before @everyone once pinged the app while the server saw nothing;
//   - its name is the run of username characters after the "@";
//   - a "." or "-" at the end of that run is punctuation ("thanks @alice."), unless the whole
//     run is the name being matched (a name may itself end in a dot).
// client/test/fixtures/mention-cases.json holds the cases both sides are tested against.
import { MAX_USERNAME, MIN_USERNAME, USERNAME_CHAR } from "./usernames.ts";

/** What may come right before a mention's "@": the start, or whitespace as Rust counts it. */
const BOUNDARY = "^|[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

/** A mention: start of text or whitespace, the "@", and its run of username characters. */
const MENTION = new RegExp(`(${BOUNDARY})@(${USERNAME_CHAR}+)`, "g");

/** A run without the "." and "-" at its end, which read as punctuation after a name. */
function withoutTrailingPunctuation(run: string): string {
  return run.replace(/[.-]+$/, "");
}

/**
 * If the caret sits inside an open `@query` (start-of-line or after whitespace,
 * no spaces yet), return the query and the index of the `@`. Otherwise null.
 */
export function activeMentionQuery(
  value: string,
  caret: number
): { query: string; at: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(new RegExp(`(?:${BOUNDARY})@(${USERNAME_CHAR}{0,${MAX_USERNAME}})$`));
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

/** True if `content` mentions `name` (in any case), by the rule above. */
function mentionsName(content: string, name: string): boolean {
  const target = name.toLowerCase();
  for (const m of content.matchAll(MENTION)) {
    const run = m[2].toLowerCase();
    if (run === target || withoutTrailingPunctuation(run) === target) return true;
  }
  return false;
}

/** True if `content` mentions `username` (case-insensitive). */
export function mentionsUser(content: string, username: string): boolean {
  if (!username) return false;
  return mentionsName(content, username);
}

/** True if `content` contains a channel-wide `@everyone` / `@here` mention. */
export function mentionsEveryone(content: string): boolean {
  return mentionsName(content, "everyone") || mentionsName(content, "here");
}

/** True if `content` mentions you — directly or via `@everyone`/`@here`. */
export function mentionsYou(content: string, username: string): boolean {
  return mentionsEveryone(content) || mentionsUser(content, username);
}

/** Split text into runs, marking `@username` tokens for pill rendering. A "." or "-" right
 *  after the name stays outside the pill ("thanks @alice." → pill "@alice", then "."). */
export function splitMentions(text: string): { text: string; mention?: string }[] {
  const out: { text: string; mention?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const name = withoutTrailingPunctuation(m[2]);
    if (name.length < MIN_USERNAME || name.length > MAX_USERNAME) continue;
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: `@${name}`, mention: name });
    last = at + 1 + name.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
