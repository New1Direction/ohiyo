// Pure layout numbers for the virtualized chat list. react-window needs a row's height
// before the row renders, so ChatPane works it out from the text; these helpers make that
// follow the real width of the list and the real size of a line instead of assuming a wide
// desktop pane. They mirror the message rules in index.css (.kc-message-row, .kc-msg,
// .msg-content); change the two together.

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

/** The numbers a row's height is built from, for the current width, density and font scale. */
export function messageRowMetrics(inputs: MessageRowInputs): MessageRowMetrics {
  const { fontScale, isPhone, lineHeight, densityBasePx } = inputs;
  const scale = fontScale > 0 ? fontScale : 1;
  const linePx = isPhone ? PHONE_FONT_PX * PHONE_LINE_HEIGHT : DESKTOP_FONT_PX * scale * lineHeight;
  // The density base was tuned as "a one-message group minus one line of text", so it
  // already holds that message's own padding; take it back out and count it per message.
  const basePx = densityBasePx - MESSAGE_PAD_PX + (isPhone ? PHONE_ROW_EXTRA_PX : 0);
  return { basePx, linePx, charsPerLine: messageCharsPerLine(inputs), textWidth: messageTextWidth(inputs) };
}

/** Cozy density on an unmeasured list: what the list uses until the first measurement. */
export const DEFAULT_ROW_METRICS: MessageRowMetrics = messageRowMetrics({
  listWidth: 0,
  fontScale: 1,
  isPhone: false,
  lineHeight: 1.45,
  densityBasePx: 44,
});

/** Height of a group's messages: each is its lines of text plus its own padding. */
export function messageGroupTextPx(lineCounts: readonly number[], linePx: number): number {
  return lineCounts.reduce((sum, lines) => sum + Math.max(1, lines) * linePx + MESSAGE_PAD_PX, 0);
}
