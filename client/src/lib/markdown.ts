// Message formatting the way Discord writes it, parsed into a small tree that ChatPane draws
// with React elements (never HTML strings). Pure, so the renderer and the row-height estimate
// (messageLayout.ts) read the same structure.
//
// Blocks: ```fenced code``` (optional language), # / ## / ### headings, -# subtext, > quotes and
// >>> (the rest of the message), - / * / 1. lists with one level of nesting, paragraphs.
// Inline: **bold**, *italic* / _italic_, __underline__, ~~strike~~, `code`, ||spoilers||,
// [masked](https://links), bare https links, :custom_emoji:, <t:unix:style> timestamps and
// \escapes. Links are only ever http(s).
//
// Linear time on hostile input: each delimiter remembers, per nesting level, that it has no
// closing partner left (a later opener can't find one either), and nesting is capped.

export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "spoiler"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[]; destinationHost: string | null }
  | { kind: "url"; href: string; text: string }
  | { kind: "emoji"; name: string }
  | { kind: "time"; unix: number; style: TimestampStyle }
  | { kind: "br" };

export type ListItem = { children: Inline[]; sublist: ListBlock | null };
export type ListBlock = { kind: "list"; ordered: boolean; start: number; items: ListItem[] };
export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { kind: "subtext"; children: Inline[] }
  | { kind: "quote"; children: Block[] }
  | ListBlock
  | { kind: "code"; lang: string | null; text: string };

const MAX_DEPTH = 8;
const ESCAPABLE = new Set("\\*_~`|>#-[]()<:");
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;
const TIME_RE = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y;
const EMOJI_RE = /:([a-z0-9_]{2,32}):/y;
const URL_TAIL = /[.,!?)\]}>'"]+$/;
const DOMAIN_IN_TEXT = /(?:^|[^a-z0-9-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?![a-z0-9-])/i;
// What a Date can hold, in seconds.
const MAX_UNIX_SECONDS = 8_640_000_000_000;

type Ctx = { depth: number; noLinks: boolean };
type Match = { node: Inline; end: number } | { literal: string; end: number };
const ROOT: Ctx = { depth: 0, noLinks: false };

/** An absolute http(s) address, normalized, or null. */
function webHref(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The real site a masked link goes to, when its words name a different one. */
function misleadingHost(words: string, url: URL): string | null {
  const named = DOMAIN_IN_TEXT.exec(words.toLowerCase());
  if (!named) return null;
  const said = bareHost(named[1]);
  const real = bareHost(url.hostname);
  return real === said || real.endsWith(`.${said}`) ? null : url.hostname;
}

/** The position of `delim` closing a span opened just before `from`, or -1. */
function findClose(src: string, from: number, delim: string): number {
  const ch = delim[0];
  let j = from;
  for (;;) {
    j = src.indexOf(delim, j);
    if (j < 0) return -1;
    // An escaped delimiter, or one that runs on (***x*** closes on its last pair), doesn't close.
    if (src[j - 1] === "\\" || (delim !== "||" && src[j + delim.length] === ch)) {
      j += 1;
      continue;
    }
    return j;
  }
}

function wrapped(
  src: string,
  i: number,
  delim: string,
  kind: "bold" | "underline" | "strike" | "spoiler",
  ctx: Ctx,
  dead: Set<string>
): Match | null {
  if (ctx.depth >= MAX_DEPTH || dead.has(delim)) return null;
  const start = i + delim.length;
  const close = findClose(src, start + 1, delim);
  if (close < 0) {
    dead.add(delim);
    return null;
  }
  const inner = src.slice(start, close);
  if (!inner.trim()) return null;
  return { node: { kind, children: inline(inner, { ...ctx, depth: ctx.depth + 1 }) }, end: close + delim.length };
}

function italicStar(src: string, i: number, ctx: Ctx, dead: Set<string>): Match | null {
  const next = src[i + 1];
  if (ctx.depth >= MAX_DEPTH || dead.has("*") || next === undefined || next === "*" || SPACE.test(next)) return null;
  let j = i + 2;
  for (;;) {
    j = src.indexOf("*", j);
    if (j < 0) {
      dead.add("*");
      return null;
    }
    if (src[j + 1] === "*") {
      j += 2; // a ** inside the italic belongs to bold
      continue;
    }
    if (src[j - 1] === "\\" || SPACE.test(src[j - 1])) {
      j += 1;
      continue;
    }
    break;
  }
  return { node: { kind: "italic", children: inline(src.slice(i + 1, j), { ...ctx, depth: ctx.depth + 1 }) }, end: j + 1 };
}

function italicUnderscore(src: string, i: number, ctx: Ctx, dead: Set<string>): Match | null {
  const next = src[i + 1];
  if (ctx.depth >= MAX_DEPTH || dead.has("_") || next === undefined || next === "_" || SPACE.test(next)) return null;
  // snake_case_name stays as written: an underscore only opens at the start of a word.
  if (i > 0 && WORD_CHAR.test(src[i - 1])) return null;
  let j = i + 2;
  for (;;) {
    j = src.indexOf("_", j);
    if (j < 0) {
      dead.add("_");
      return null;
    }
    if (src[j + 1] === "_") {
      j += 2;
      continue;
    }
    const after = src[j + 1];
    if (src[j - 1] === "\\" || SPACE.test(src[j - 1]) || (after !== undefined && WORD_CHAR.test(after))) {
      j += 1;
      continue;
    }
    break;
  }
  return { node: { kind: "italic", children: inline(src.slice(i + 1, j), { ...ctx, depth: ctx.depth + 1 }) }, end: j + 1 };
}

function inlineCode(src: string, i: number, dead: Set<string>): Match {
  let run = 1;
  while (src[i + run] === "`") run += 1;
  const ticks = "`".repeat(run);
  const key = `\`${run}`;
  if (!dead.has(key)) {
    let j = i + run;
    for (;;) {
      j = src.indexOf(ticks, j);
      if (j < 0) {
        dead.add(key);
        break;
      }
      // The closing run must be exactly as long as the opening one.
      if (src[j + run] === "`") {
        while (src[j] === "`") j += 1;
        continue;
      }
      let text = src.slice(i + run, j);
      if (!text) break;
      if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
      return { node: { kind: "code", text }, end: j + run };
    }
  }
  // No partner: the whole run is shown as written.
  return { literal: ticks, end: i + run };
}

function maskedLink(src: string, i: number, ctx: Ctx, dead: Set<string>): Match | null {
  if (ctx.noLinks || ctx.depth >= MAX_DEPTH || dead.has("[")) return null;
  const mid = src.indexOf("](", i + 1);
  if (mid < 0) {
    dead.add("[");
    return null;
  }
  const words = src.slice(i + 1, mid);
  if (!words.trim() || words.includes("[") || words.includes("\n")) return null;
  if (dead.has(")")) return null;
  let close = src.indexOf(")", mid + 2);
  if (close < 0) {
    dead.add(")");
    return null;
  }
  // An address may hold balanced parentheses (a Wikipedia page, say).
  let raw = src.slice(mid + 2, close);
  while ((raw.match(/\(/g)?.length ?? 0) > (raw.match(/\)/g)?.length ?? 0)) {
    const further = src.indexOf(")", close + 1);
    if (further < 0) break;
    close = further;
    raw = src.slice(mid + 2, close);
  }
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
  if (!raw || SPACE.test(raw)) return null;
  const url = webHref(raw);
  if (!url) return null;
  return {
    node: {
      kind: "link",
      href: url.href,
      children: inline(words, { depth: ctx.depth + 1, noLinks: true }),
      destinationHost: misleadingHost(words, url),
    },
    end: close + 1,
  };
}

function bareUrl(src: string, i: number): Match | null {
  if (!src.startsWith("https://", i) && !src.startsWith("http://", i)) return null;
  if (i > 0 && /[A-Za-z0-9]/.test(src[i - 1])) return null;
  let j = i;
  while (j < src.length && !SPACE.test(src[j]) && src[j] !== "<") j += 1;
  const text = src.slice(i, j).replace(URL_TAIL, "");
  const url = webHref(text);
  if (!url) return { literal: text || src[i], end: i + Math.max(1, text.length) };
  return { node: { kind: "url", href: url.href, text }, end: i + text.length };
}

function timestamp(src: string, i: number): Match | null {
  TIME_RE.lastIndex = i;
  const m = TIME_RE.exec(src);
  if (!m) return null;
  const unix = Number(m[1]);
  if (!Number.isSafeInteger(unix) || Math.abs(unix) > MAX_UNIX_SECONDS) return null;
  return { node: { kind: "time", unix, style: (m[2] as TimestampStyle | undefined) ?? "f" }, end: i + m[0].length };
}

function emoji(src: string, i: number): Match | null {
  EMOJI_RE.lastIndex = i;
  const m = EMOJI_RE.exec(src);
  // All digits is a clock (10:30:45) or a number, not an emoji name.
  if (!m || /^\d+$/.test(m[1])) return null;
  return { node: { kind: "emoji", name: m[1] }, end: i + m[0].length };
}

function token(src: string, i: number, ctx: Ctx, dead: Set<string>): Match | null {
  switch (src[i]) {
    case "`":
      return inlineCode(src, i, dead);
    case "|":
      return src[i + 1] === "|" ? wrapped(src, i, "||", "spoiler", ctx, dead) : null;
    case "*":
      return (src[i + 1] === "*" ? wrapped(src, i, "**", "bold", ctx, dead) : null) ?? italicStar(src, i, ctx, dead);
    case "_":
      return (src[i + 1] === "_" ? wrapped(src, i, "__", "underline", ctx, dead) : null) ?? italicUnderscore(src, i, ctx, dead);
    case "~":
      return src[i + 1] === "~" ? wrapped(src, i, "~~", "strike", ctx, dead) : null;
    case "[":
      return maskedLink(src, i, ctx, dead);
    case "<":
      return timestamp(src, i);
    case ":":
      return emoji(src, i);
    case "h":
      return ctx.noLinks ? null : bareUrl(src, i);
    default:
      return null;
  }
}

function inline(src: string, ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  const dead = new Set<string>();
  let text = "";
  const push = (node: Inline) => {
    if (text) out.push({ kind: "text", text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      push({ kind: "br" });
      i += 1;
      continue;
    }
    const m = token(src, i, ctx, dead);
    if (m && "node" in m) {
      push(m.node);
      i = m.end;
    } else if (m) {
      text += m.literal;
      i = m.end;
    } else {
      text += c;
      i += 1;
    }
  }
  if (text) out.push({ kind: "text", text });
  return out;
}

/** Inline formatting only: what a line of a message holds. */
export function parseInline(src: string): Inline[] {
  return inline(src, ROOT);
}

const HEADING = /^(#{1,3}) (.*)$/;
const SUBTEXT = /^-# (.*)$/;
const LIST_ITEM = /^( *)(?:[-*]|(\d{1,9})\.) (.*)$/;

function listAt(lines: readonly string[], k: number, blocks: Block[]): number {
  let current: ListBlock | null = null;
  for (; k < lines.length; k += 1) {
    const m = LIST_ITEM.exec(lines[k]);
    if (!m || SUBTEXT.test(lines[k])) break;
    const ordered = m[2] !== undefined;
    const start = ordered ? Number(m[2]) : 1;
    const item: ListItem = { children: inline(m[3], ROOT), sublist: null };
    const parent = current ? current.items[current.items.length - 1] : undefined;
    if (m[1].length >= 2 && parent) {
      if (!parent.sublist) parent.sublist = { kind: "list", ordered, start, items: [] };
      parent.sublist.items.push(item);
      continue;
    }
    if (!current || current.ordered !== ordered) {
      current = { kind: "list", ordered, start, items: [] };
      blocks.push(current);
    }
    current.items.push(item);
  }
  return k;
}

function linesInto(segment: string, blocks: Block[], quotes: boolean): void {
  if (!segment) return;
  const lines = segment.split("\n");
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", children: inline(paragraph.join("\n"), ROOT) });
    paragraph.length = 0;
  };
  let k = 0;
  while (k < lines.length) {
    const line = lines[k];
    if (quotes && (line === ">>>" || line.startsWith(">>> "))) {
      flush();
      const children: Block[] = [];
      linesInto([line.slice(4), ...lines.slice(k + 1)].join("\n"), children, false);
      blocks.push({ kind: "quote", children });
      return;
    }
    if (quotes && (line === ">" || line.startsWith("> "))) {
      flush();
      const quoted: string[] = [];
      for (; k < lines.length && (lines[k] === ">" || lines[k].startsWith("> ")); k += 1) quoted.push(lines[k].slice(2));
      const children: Block[] = [];
      linesInto(quoted.join("\n"), children, false);
      blocks.push({ kind: "quote", children });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && heading[2].trim()) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, children: inline(heading[2].trim(), ROOT) });
      k += 1;
      continue;
    }
    const subtext = SUBTEXT.exec(line);
    if (subtext && subtext[1].trim()) {
      flush();
      blocks.push({ kind: "subtext", children: inline(subtext[1].trim(), ROOT) });
      k += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      k = listAt(lines, k, blocks);
      continue;
    }
    paragraph.push(line);
    k += 1;
  }
  flush();
}

function codeBlock(inner: string): Block {
  const lang = /^([A-Za-z0-9_+#.-]{1,32})\n/.exec(inner);
  let text = lang ? inner.slice(lang[0].length) : inner.startsWith("\n") ? inner.slice(1) : inner;
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return { kind: "code", lang: lang ? lang[1] : null, text };
}

/** A whole message: its blocks, in order. */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  for (;;) {
    const open = src.indexOf("```", i);
    if (open < 0) break;
    const close = src.indexOf("```", open + 3);
    if (close < 0) break;
    const before = src.slice(i, open);
    linesInto(before.endsWith("\n") ? before.slice(0, -1) : before, blocks, true);
    blocks.push(codeBlock(src.slice(open + 3, close)));
    i = close + 3;
    if (src[i] === "\n") i += 1;
  }
  linesInto(src.slice(i), blocks, true);
  return blocks;
}

// How wide a timestamp is drawn, in characters, for estimating row heights.
const TIME_WIDTH: Record<TimestampStyle, number> = { t: 8, T: 11, d: 10, D: 18, f: 27, F: 38, R: 14 };

/** The text a reader sees, for measuring: formatting marks gone, line breaks kept. */
export function inlinePlainText(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        out += node.text;
        break;
      case "url":
        out += node.text;
        break;
      case "br":
        out += "\n";
        break;
      case "emoji":
        out += `:${node.name}:`;
        break;
      case "time":
        out += "0".repeat(TIME_WIDTH[node.style]);
        break;
      case "link":
        out += inlinePlainText(node.children) + (node.destinationHost ? ` (${node.destinationHost})` : "");
        break;
      default:
        out += inlinePlainText(node.children);
    }
  }
  return out;
}

type TimestampOptions = { now: number; locale?: string; timeZone?: string };

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

function relative(seconds: number, locale: string | undefined): string {
  const abs = Math.abs(seconds);
  if (abs < 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size) return format.format(Math.round(seconds / size) || Math.sign(seconds), unit);
  }
  return format.format(Math.round(seconds), "second");
}

/** A <t:unix:style> timestamp in the reader's locale, in Discord's styles. */
export function formatTimestamp(unix: number, style: TimestampStyle, opts: TimestampOptions): string {
  const date = new Date(unix * 1000);
  const zone: Intl.DateTimeFormatOptions = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(opts.locale, { ...zone, ...o }).format(date);
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const longDate: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
  switch (style) {
    case "t":
      return fmt(time);
    case "T":
      return fmt({ ...time, second: "2-digit" });
    case "d":
      return fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
    case "D":
      return fmt(longDate);
    case "F":
      return `${fmt({ weekday: "long", ...longDate })} ${fmt(time)}`;
    case "R":
      return relative(unix - opts.now / 1000, opts.locale);
    default:
      return `${fmt(longDate)} ${fmt(time)}`;
  }
}
