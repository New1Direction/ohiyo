// Which links in a message get a card under it (a preview, a YouTube player, a post on X).
// One list for two readers: the renderer draws a card for each entry, and the virtualized
// list reserves room for each entry before the row renders. They must never disagree, or a
// card runs into the next message (too little room) or leaves a gap (too much). Pure.

// Punctuation that ends a sentence or closes a bracket around a link, not the link itself.
const URL_TAIL = /[.,!?)\]}>'"]+$/;

/** A link as written in a message, without the punctuation that follows it. */
export function trimUrlTail(raw: string): string {
  return raw.replace(URL_TAIL, "");
}

function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// The parts of a message that are shown as written, with no links made of them. They
// mirror MessageContent: a forwarded-from header, fenced code, spoilers, inline code.
const FORWARD_HEADER = /^【FWD:[^】]*】/;
const NOT_LINKED = [/```[\s\S]*?```/g, /\|\|.+?\|\|/g, /`[^`]+`/g];

/**
 * The links in `content` that get a card, each once, in the order they first appear.
 * A link inside code is text, and one inside a spoiler would be given away by its card.
 */
export function linkCardUrls(content: string): string[] {
  const text = NOT_LINKED.reduce((rest, pattern) => rest.replace(pattern, " "), content.replace(FORWARD_HEADER, ""));
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const url = webUrl(trimUrlTail(match[0]));
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
