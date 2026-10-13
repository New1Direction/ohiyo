// What a message search asks for, read from the search box the way Discord reads it:
// `from:alice in:general has:link before:2026-10-01 "big deploy"`. The server reads the box
// with the same rule (server/src/api/search_query.rs); both are tested against
// client/test/fixtures/search-cases.json.
//
//   - Whitespace (as Rust counts it) separates words; a `"` opens or closes a quoted run
//     inside a word, so `in:"release notes"` is one word; an unclosed quote runs to the end.
//   - A word `key:value` with a known key and a value that fits is a filter. Anything else,
//     including a word that starts with a quote, is text every result must contain.
//   - from:, mentions:, in: and has: add up (each value once); for dates and pinned: the
//     last one wins.
import { RUST_WHITESPACE } from "./mentions.ts";

export const SEARCH_KEYS = ["from", "mentions", "in", "has", "before", "after", "during", "pinned"] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];
export const HAS_KINDS = ["link", "file", "image", "video", "embed"] as const;

/** Longest from:/mentions: value (a webhook's name can be 64 characters). */
const MAX_NAME_CHARS = 64;
/** Longest in: value (a channel or thread name). */
const MAX_CHANNEL_CHARS = 100;

export type ParsedSearch = {
  text: string[];
  from: string[];
  mentions: string[];
  in: string[];
  has: string[];
  before: string | null;
  after: string | null;
  during: string | null;
  pinned: boolean | null;
};

const SPACE = new RegExp(`^${RUST_WHITESPACE}$`);
const isSpace = (c: string) => SPACE.test(c);

type Token = { text: string; quoted: boolean; start: number; end: number };

/** The box split into words: each word's text (quotes taken out), whether it began with a
 *  quote, and where it sits in the box (in code points, as `[...q]` counts them). */
function tokens(q: string): Token[] {
  const out: Token[] = [];
  const chars = [...q];
  let i = 0;
  for (;;) {
    while (i < chars.length && isSpace(chars[i])) i += 1;
    if (i >= chars.length) break;
    const start = i;
    const quoted = chars[i] === '"';
    let text = "";
    let inQuote = false;
    for (; i < chars.length; i += 1) {
      const c = chars[i];
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote && isSpace(c)) break;
      else text += c;
    }
    if (text) out.push({ text, quoted, start, end: i });
  }
  return out;
}

/** `YYYY-MM-DD` naming a day that exists. */
export function isDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A word read as a filter: its key and its value as the search uses it. Null for text. */
function readFilter(token: Token): { key: SearchKey; value: string } | null {
  if (token.quoted) return null;
  const colon = token.text.indexOf(":");
  if (colon < 0) return null;
  const key = token.text.slice(0, colon).toLowerCase();
  const raw = token.text.slice(colon + 1).trim();
  if (key === "from" || key === "mentions") {
    const name = raw.replace(/^@/, "").toLowerCase();
    return name.length > 0 && [...name].length <= MAX_NAME_CHARS ? { key, value: name } : null;
  }
  if (key === "in") {
    const name = raw.replace(/^#/, "").toLowerCase();
    return name.length > 0 && [...name].length <= MAX_CHANNEL_CHARS ? { key, value: name } : null;
  }
  if (key === "has") {
    const kind = raw.toLowerCase();
    return (HAS_KINDS as readonly string[]).includes(kind) ? { key, value: kind } : null;
  }
  if (key === "before" || key === "after" || key === "during") return isDay(raw) ? { key, value: raw } : null;
  if (key === "pinned") {
    const v = raw.toLowerCase();
    return v === "true" || v === "false" ? { key, value: v } : null;
  }
  return null;
}

const pushOnce = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

/** Read a search box's text. */
export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: [], from: [], mentions: [], in: [], has: [], before: null, after: null, during: null, pinned: null };
  for (const token of tokens(q)) {
    const filter = readFilter(token);
    if (!filter) {
      out.text.push(token.text);
      continue;
    }
    const { key, value } = filter;
    if (key === "from" || key === "mentions" || key === "in" || key === "has") pushOnce(out[key], value);
    else if (key === "pinned") out.pinned = value === "true";
    else out[key] = value;
  }
  return out;
}

/** A filter in the box, shown as a chip, with where it sits so it can be taken out. */
export type SearchChip = { key: SearchKey; value: string; start: number; end: number };

/** The filters in the box, in the order they were typed. */
export function chipsOf(q: string): SearchChip[] {
  return tokens(q).flatMap((t) => {
    const f = readFilter(t);
    return f ? [{ ...f, start: t.start, end: t.end }] : [];
  });
}

/** The box without `chip` (and the space after it). */
export function withoutChip(q: string, chip: SearchChip): string {
  const chars = [...q];
  let end = chip.end;
  while (end < chars.length && isSpace(chars[end])) end += 1;
  return [...chars.slice(0, chip.start), ...chars.slice(end)].join("");
}

/** True when the search asks for nothing at all. */
export function isEmptySearch(p: ParsedSearch): boolean {
  return (
    p.text.length + p.from.length + p.mentions.length + p.in.length + p.has.length === 0 &&
    p.before === null &&
    p.after === null &&
    p.during === null &&
    p.pinned === null
  );
}

// ── Suggestions while typing ──────────────────────────────────────────────────

export type SuggestionItem = { label: string; detail?: string; insert: string; avatarOf?: string };
export type Suggestions = { from: number; to: number; items: SuggestionItem[] };
export type SuggestionContext = {
  members: { id: string; username: string; display_name: string }[];
  channels: { name: string }[];
  /** Now, in ms; dates are suggested in the person's own day. */
  now: number;
};

const KEY_HINTS: Record<SearchKey, string> = {
  from: "a person",
  mentions: "who is mentioned",
  in: "a channel",
  has: "link, file, image, video or embed",
  before: "a day",
  after: "a day",
  during: "a day",
  pinned: "true or false",
};

/** Most people or channels offered at once. */
const MAX_OFFERED = 8;

/** The person's own day `daysAgo` days before `now`, as `YYYY-MM-DD`. */
function localDay(now: number, daysAgo: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Matches first by how the text starts, then anywhere in it. */
function ranked<T>(list: T[], keysOf: (item: T) => string[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = list.filter((x) => keysOf(x).some((k) => k.toLowerCase().startsWith(q)));
  const within = list.filter((x) => !starts.includes(x) && keysOf(x).some((k) => k.toLowerCase().includes(q)));
  return [...starts, ...within].slice(0, MAX_OFFERED);
}

/** What to offer for the word under the caret. Null when there's nothing to suggest. */
export function suggestionsFor(value: string, caret: number, ctx: SuggestionContext): Suggestions | null {
  // The word the caret is in (or at the end of): back to the last whitespace, on to the next.
  let from = caret;
  while (from > 0 && !isSpace(value[from - 1])) from -= 1;
  let to = caret;
  while (to < value.length && !isSpace(value[to])) to += 1;
  const word = value.slice(from, caret);
  if (word.startsWith('"')) return null;
  const colon = word.indexOf(":");
  const done = (items: SuggestionItem[]): Suggestions | null => (items.length ? { from, to, items } : null);

  if (colon < 0) {
    const typed = word.toLowerCase();
    return done(
      SEARCH_KEYS.filter((k) => k.startsWith(typed)).map((k) => ({ label: `${k}:`, detail: KEY_HINTS[k], insert: `${k}:` })),
    );
  }
  const key = word.slice(0, colon).toLowerCase() as SearchKey;
  const typed = word.slice(colon + 1);
  switch (key) {
    case "from":
    case "mentions": {
      const q = typed.replace(/^@/, "");
      return done(
        ranked(ctx.members, (m) => [m.username, m.display_name], q).map((m) => ({
          label: m.display_name || m.username,
          detail: m.username,
          insert: `${key}:${m.username} `,
          avatarOf: m.id,
        })),
      );
    }
    case "in": {
      const q = typed.replace(/^#/, "");
      return done(ranked(ctx.channels, (c) => [c.name], q).map((c) => ({ label: `#${c.name}`, insert: `in:${c.name} ` })));
    }
    case "has":
      return done(HAS_KINDS.filter((k) => k.startsWith(typed.toLowerCase())).map((k) => ({ label: k, insert: `has:${k} ` })));
    case "before":
    case "after":
    case "during": {
      const days = [
        { label: "Today", day: localDay(ctx.now, 0) },
        { label: "Yesterday", day: localDay(ctx.now, 1) },
      ];
      return done(days.filter((d) => d.day.startsWith(typed)).map((d) => ({ label: d.label, detail: d.day, insert: `${key}:${d.day} ` })));
    }
    case "pinned":
      return done(["true", "false"].filter((v) => v.startsWith(typed.toLowerCase())).map((v) => ({ label: v, insert: `pinned:${v} ` })));
    default:
      return null;
  }
}

/** Put a suggestion in place of the word it was offered for. */
export function applySuggestion(value: string, s: Suggestions, item: SuggestionItem): { value: string; caret: number } {
  // A finished value ends in a space; don't double it when the box already has one there.
  const rest = value.slice(s.to);
  const insert = item.insert.endsWith(" ") && rest.startsWith(" ") ? item.insert.slice(0, -1) : item.insert;
  const next = value.slice(0, s.from) + insert + rest;
  const caret = s.from + insert.length + (insert === item.insert ? 0 : 1);
  return { value: next, caret };
}

// ── Marking matches ───────────────────────────────────────────────────────────

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` cut into the parts that match one of `terms` (any case) and the parts between. */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const wanted = terms.filter((t) => t.trim().length > 0).sort((a, b) => b.length - a.length);
  if (!wanted.length || !text) return [{ text, hit: false }];
  const re = new RegExp(wanted.map(escapeRegExp).join("|"), "gi");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (!m[0]) continue;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}
