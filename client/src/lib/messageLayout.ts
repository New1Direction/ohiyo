// Pure layout numbers for the virtualized chat list. react-window needs a row's height
// before the row renders, so ChatPane works it out from the text; these helpers make that
// follow the real width of the list and the real size of a line instead of assuming a wide
// desktop pane. They mirror the message rules in index.css (.kc-message-row, .kc-msg,
// .msg-content); change the two together.

import { inlinePlainText, parseMarkdown, type Block, type ListBlock } from "./markdown.ts";

/** The guess used before the list has been measured. */
export const DEFAULT_CHARS_PER_LINE = 80;
const MIN_CHARS_PER_LINE = 12;

// Average glyph width as a share of the font size. Ordinary English measures about 0.47
// once word wrapping is counted; the extra is on purpose, because guessing one line too
// many leaves a small gap and guessing one too few makes rows overlap.
const AVG_CHAR_EM = 0.5;
// CJK, full-width forms and emoji are about twice as wide as a Latin letter.
const WIDE_CHARS = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/gu;

// Desktop row: 16px padding each side + 40px avatar + 12px gap; text is 0.875rem * scale.
const DESKTOP_GUTTER_PX = 84;
const DESKTOP_FONT_PX = 14;
// Phone row: 0.65rem padding each side + 2rem avatar + 0.55rem gap; text is a fixed 0.98rem
// at line-height 1.45, whatever the density and font scale are, and the row has 0.7rem of
// top padding where desktop has 0.5rem.
const PHONE_GUTTER_PX = 62;
const PHONE_FONT_PX = 15.68;
const PHONE_LINE_HEIGHT = 1.45;
const PHONE_ROW_EXTRA_PX = 3.2;
/** Matches the phone block in index.css. */
export const PHONE_LAYOUT_QUERY = "(max-width: 640px)";
// Touch screens: every message has a ⋯ button on its right, and .kc-msg keeps this much
// padding free for it so text never runs underneath.
const TOUCH_ACTIONS_PX = 44;
/** Matches the touch block in index.css. */
export const TOUCH_ACTIONS_QUERY = "(hover: none) and (pointer: coarse)";

// Every message in a group has its own 1px + 2px of padding (.kc-msg).
const MESSAGE_PAD_PX = 3;

export interface MessageListMetrics {
  /** Width of the message list in CSS pixels; 0 or NaN when it has not been measured. */
  listWidth: number;
  fontScale: number;
  /** True when the phone stylesheet is active. */
  isPhone: boolean;
  /** True on touch screens, where each message makes room for its ⋯ button. */
  hasTouchActions?: boolean;
}

export interface MessageRowInputs extends MessageListMetrics {
  /** The density's line-height (--msg-line-height). */
  lineHeight: number;
  /** The density's base row height (--msg-base-px): one message group minus its text. */
  densityBasePx: number;
}

export interface MessageRowMetrics {
  /** Height of a group before its messages: padding, the name line, the gap below. */
  basePx: number;
  /** Height of one line of message text. */
  linePx: number;
  /** Size of message text. */
  fontPx: number;
  charsPerLine: number;
  /** Width of the message text column; 0 when the list has not been measured. */
  textWidth: number;
}

/** Width of the message text column: the list minus padding, avatar, gap and the ⋯ button. */
function messageTextWidth({ listWidth, isPhone, hasTouchActions }: Pick<MessageListMetrics, "listWidth" | "isPhone" | "hasTouchActions">): number {
  if (!Number.isFinite(listWidth) || listWidth <= 0) return 0;
  const gutter = (isPhone ? PHONE_GUTTER_PX : DESKTOP_GUTTER_PX) + (hasTouchActions ? TOUCH_ACTIONS_PX : 0);
  return Math.max(0, listWidth - gutter);
}

/** How many characters of message text fit on one line of the list. */
export function messageCharsPerLine({ listWidth, fontScale, isPhone, hasTouchActions }: MessageListMetrics): number {
  const scale = fontScale > 0 ? fontScale : 1;
  const textWidth = messageTextWidth({ listWidth, isPhone, hasTouchActions });
  if (textWidth <= 0) {
    return Math.max(MIN_CHARS_PER_LINE, Math.round(DEFAULT_CHARS_PER_LINE / scale));
  }
  const fontPx = isPhone ? PHONE_FONT_PX : DESKTOP_FONT_PX * scale;
  return Math.max(MIN_CHARS_PER_LINE, Math.floor(textWidth / (fontPx * AVG_CHAR_EM)));
}

/** Width of a run of text in Latin-letter columns: a wide character takes two. */
function columns(text: string): number {
  const wide = text.match(WIDE_CHARS)?.length ?? 0;
  // Array.from counts code points, so an emoji is one character, not two UTF-16 units.
  return wide === 0 ? text.length : Array.from(text).length + wide;
}

/** Lines one paragraph takes when words wrap whole and only an over-long word is broken. */
function wrappedLines(paragraph: string, charsPerLine: number): number {
  let lines = 1;
  let used = 0; // columns taken on the current line
  for (const word of paragraph.split(" ")) {
    const width = columns(word);
    const needed = used === 0 ? width : used + 1 + width;
    if (needed <= charsPerLine) {
      used = needed;
    } else if (width <= charsPerLine) {
      lines += 1;
      used = width;
    } else {
      // Too long for any line (a link, say): it starts a fresh line, then is cut to fit.
      if (used > 0) lines += 1;
      lines += Math.ceil(width / charsPerLine) - 1;
      used = width % charsPerLine || charsPerLine;
    }
  }
  return lines;
}

/** How many lines a message takes: every line break starts a new one, long lines wrap. */
export function messageLineCount(text: string, charsPerLine: number): number {
  return text.split("\n").reduce((lines, paragraph) => lines + wrappedLines(paragraph, charsPerLine), 0);
}

// Formatted text (MessageMarkdown, `.kc-md-*` and `.code-block` in index.css). Sizes are in
// ems of the message text unless marked px; change the two together.
const HEADING_SCALE = [1.5, 1.25, 1.0625];
const HEADING_LINE_HEIGHT = 1.375;
const HEADING_GAP_EM = 0.4; // above a heading that isn't the first thing in its box
const HEADING_WIDTH = 1.08; // bold glyphs are wider
const SUBTEXT_SCALE = 0.8125;
const SUBTEXT_LINE_HEIGHT = 1.3;
const QUOTE_INDENT_PX = 16; // 4px bar + 12px padding
const LIST_INDENT_EM = 1.5;
const CODE_FONT_PX = 13;
const CODE_BOX_PX = 20 + 12; // padding top and bottom, margin top and bottom
const CODE_SIDE_PX = 28 + 3; // padding left and right, the accent bar
const CODE_CHAR_EM = 0.6; // monospace
const CODE_SCROLLBAR_PX = 15; // a line too long for the box scrolls sideways
const BIG_EMOJI_PX = 40 * 1.2; // 2.5rem at line-height 1.2
const FORWARD_FONT_PX = 11;
const FORWARD_GAP_PX = 2;

type ContentMetrics = Pick<MessageRowMetrics, "linePx" | "fontPx" | "charsPerLine" | "textWidth">;

/** Lines a run of drawn text takes at `charsPerLine`. */
function textLines(text: string, charsPerLine: number): number {
  return text.split("\n").reduce((lines, paragraph) => lines + wrappedLines(paragraph, charsPerLine), 0);
}

/** Characters per line once `px` of the line is given to an indent. */
function narrower(charsPerLine: number, m: ContentMetrics, px: number): number {
  const fewer = m.textWidth > 0 ? Math.floor((charsPerLine * px) / m.textWidth) : Math.ceil(px / (m.fontPx * AVG_CHAR_EM));
  return Math.max(MIN_CHARS_PER_LINE, charsPerLine - fewer);
}

function listPx(list: ListBlock, m: ContentMetrics, charsPerLine: number): number {
  const inner = narrower(charsPerLine, m, m.fontPx * LIST_INDENT_EM);
  return list.items.reduce(
    (sum, item) =>
      sum + textLines(inlinePlainText(item.children), inner) * m.linePx + (item.sublist ? listPx(item.sublist, m, inner) : 0),
    0
  );
}

function blocksPx(blocks: readonly Block[], m: ContentMetrics, charsPerLine: number): number {
  const lineHeight = m.linePx / m.fontPx;
  return blocks.reduce((sum, block, index) => {
    switch (block.kind) {
      case "paragraph":
        return sum + textLines(inlinePlainText(block.children), charsPerLine) * m.linePx;
      case "heading": {
        const scale = HEADING_SCALE[block.level - 1];
        const fits = Math.max(MIN_CHARS_PER_LINE, Math.floor(charsPerLine / (scale * HEADING_WIDTH)));
        const lines = textLines(inlinePlainText(block.children), fits);
        return sum + lines * m.fontPx * scale * HEADING_LINE_HEIGHT + (index > 0 ? m.fontPx * scale * HEADING_GAP_EM : 0);
      }
      case "subtext": {
        const fits = Math.max(MIN_CHARS_PER_LINE, Math.floor(charsPerLine / SUBTEXT_SCALE));
        return sum + textLines(inlinePlainText(block.children), fits) * m.fontPx * SUBTEXT_SCALE * SUBTEXT_LINE_HEIGHT;
      }
      case "quote":
        return sum + blocksPx(block.children, m, narrower(charsPerLine, m, QUOTE_INDENT_PX));
      case "list":
        return sum + listPx(block, m, charsPerLine);
      case "code": {
        const lines = block.text.split("\n");
        const fits = m.textWidth > 0 ? Math.floor((m.textWidth - CODE_SIDE_PX) / (CODE_FONT_PX * CODE_CHAR_EM)) : Infinity;
        const scrolls = lines.some((line) => columns(line) > fits);
        return sum + lines.length * CODE_FONT_PX * lineHeight + CODE_BOX_PX + (scrolls ? CODE_SCROLLBAR_PX : 0);
      }
    }
  }, 0);
}

/**
 * Height of a message's text as drawn, formatting included; an empty message takes a line.
 * `trailer`: an inline label follows the text ("(edited)", a disappearing-message timer).
 * It sits at the end of a last line of text, but after a heading, list, quote or code block
 * it needs a line of its own.
 */
export function messageContentPx(text: string, m: ContentMetrics, trailer = false): number {
  if (!text) return m.linePx;
  const forwarded = /^【FWD:[^】]*】([\s\S]*)$/.exec(text);
  if (forwarded) {
    const header = FORWARD_FONT_PX * (m.linePx / m.fontPx) + FORWARD_GAP_PX;
    return header + (forwarded[1] ? messageContentPx(forwarded[1], m, trailer) : trailer ? m.linePx : 0);
  }
  if (text.startsWith("【BIG_EMOJI:") && text.endsWith("】")) return Math.max(m.linePx, BIG_EMOJI_PX);
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return m.linePx;
  const ownLine = trailer && blocks[blocks.length - 1].kind !== "paragraph" ? m.linePx : 0;
  return blocksPx(blocks, m, m.charsPerLine) + ownLine;
}

/** The numbers a row's height is built from, for the current width, density and font scale. */
export function messageRowMetrics(inputs: MessageRowInputs): MessageRowMetrics {
  const { fontScale, isPhone, lineHeight, densityBasePx } = inputs;
  const scale = fontScale > 0 ? fontScale : 1;
  const linePx = isPhone ? PHONE_FONT_PX * PHONE_LINE_HEIGHT : DESKTOP_FONT_PX * scale * lineHeight;
  // The density base was tuned as "a one-message group minus one line of text", so it
  // already holds that message's own padding; take it back out and count it per message.
  const basePx = densityBasePx - MESSAGE_PAD_PX + (isPhone ? PHONE_ROW_EXTRA_PX : 0);
  const fontPx = isPhone ? PHONE_FONT_PX : DESKTOP_FONT_PX * scale;
  return { basePx, linePx, fontPx, charsPerLine: messageCharsPerLine(inputs), textWidth: messageTextWidth(inputs) };
}

/** Cozy density on an unmeasured list: what the list uses until the first measurement. */
export const DEFAULT_ROW_METRICS: MessageRowMetrics = messageRowMetrics({
  listWidth: 0,
  fontScale: 1,
  isPhone: false,
  lineHeight: 1.45,
  densityBasePx: 44,
});

// The card shown in place of a message this device can't decrypt (UndecryptableMessage in
// ChatPane): at most 28rem wide and inset 8px each side within the message, 1px border,
// 0.75rem padding and 0.25rem above it. A bold 0.75rem title on 1rem lines, 0.25rem gap,
// 0.75rem text on 1.25rem lines, and an optional button 0.5rem below (28px tall). Measured
// in Chromium; change the two together.
const LOCKED_CARD_MAX_PX = 448;
const LOCKED_CARD_SIDE_PX = 16; // the message's own padding, both sides
const LOCKED_CARD_INSET_PX = 26; // the card's padding and border, both sides
const LOCKED_CARD_FRAME_PX = 4 + 2 + 24 + 4; // margin, border, padding, title-to-text gap
const LOCKED_FONT_PX = 12;
// Bold titles run wide: "This message still can’t be decrypted" (37 characters) takes two
// lines in a 286px card, about 0.65em a character.
const LOCKED_TITLE_CHAR_EM = 0.66;
const LOCKED_TITLE_LINE_PX = 16;
const LOCKED_BODY_LINE_PX = 20;
const LOCKED_BUTTON_PX = 8 + 28;

export interface LockedCardCopy {
  title: string;
  body: string;
  hasButton: boolean;
}

/** Height of the card that stands in for a message this device can't decrypt. */
export function lockedCardPx({ title, body, hasButton }: LockedCardCopy, textWidth: number): number {
  const width = textWidth > 0 ? Math.min(LOCKED_CARD_MAX_PX, textWidth - LOCKED_CARD_SIDE_PX) : LOCKED_CARD_MAX_PX;
  const inner = Math.max(0, width - LOCKED_CARD_INSET_PX);
  const titleChars = Math.max(MIN_CHARS_PER_LINE, Math.floor(inner / (LOCKED_FONT_PX * LOCKED_TITLE_CHAR_EM)));
  const bodyChars = Math.max(MIN_CHARS_PER_LINE, Math.floor(inner / (LOCKED_FONT_PX * AVG_CHAR_EM)));
  return (
    LOCKED_CARD_FRAME_PX +
    messageLineCount(title, titleChars) * LOCKED_TITLE_LINE_PX +
    messageLineCount(body, bodyChars) * LOCKED_BODY_LINE_PX +
    (hasButton ? LOCKED_BUTTON_PX : 0)
  );
}

/** Height of a group's messages: each is its lines of text plus its own padding. */
export function messageGroupTextPx(lineCounts: readonly number[], linePx: number): number {
  return lineCounts.reduce((sum, lines) => sum + Math.max(1, lines) * linePx + MESSAGE_PAD_PX, 0);
}

// Reaction chips under a message: a 22px chip with a 4px gap above (`.kc-reaction` in
// index.css; the chip row is `mt-1 gap-1` in ChatPane), each at most about 52px wide plus
// a 4px gap. A group keeps 6px extra once, so one reacted message stays at its tuned 32px.
const REACTION_ROW_PX = 26;
const REACTION_CHIP_SLOT_PX = 56;
const REACTION_GROUP_EXTRA_PX = 6;

/** Height of the reaction rows in one message group. `counts` is how many different
 *  reactions each message has (0 for none); each reacted message wraps its chips onto as
 *  many rows as the text column needs. */
export function reactionsPx(counts: readonly number[], textWidth: number): number {
  const perRow = Math.max(1, Math.floor((textWidth + 4) / REACTION_CHIP_SLOT_PX));
  const rows = counts.reduce((sum, n) => sum + (n > 0 ? Math.ceil(n / perRow) : 0), 0);
  return rows === 0 ? 0 : REACTION_GROUP_EXTRA_PX + rows * REACTION_ROW_PX;
}
