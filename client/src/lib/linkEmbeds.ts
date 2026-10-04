// Links that can play in the chat: a YouTube video or a post on X. This file decides which
// links count, builds the one frame URL each may load, reads the one message X's frame
// sends back, and works out how tall each card is. Pure, for unit tests.
//
// Nothing here loads anything. The card (components/LinkEmbeds.tsx) only puts a frame on
// the page after a click, so reading a chat never tells YouTube or X who is reading it.

export type LinkEmbed =
  | { kind: "youtube"; id: string; /** Seconds into the video; 0 is the beginning. */ start: number }
  | { kind: "x"; id: string; /** Without the @; "" when the link does not name the author. */ handle: string };

// Exact hosts only: "youtube.com.evil.example" and "evilx.com" are not these sites.
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const YOUTUBE_SHORT_HOST = "youtu.be";
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

// Both ids end up in a frame URL, so each must be exactly what the site itself uses.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const X_POST_ID = /^\d{1,20}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const YOUTUBE_PATHS = new Set(["embed", "shorts", "live"]);

// "90", "90s", "1m30s", "1h2m3s".
const TIMESTAMP = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;
const MAX_START_SECONDS = 24 * 60 * 60;

function startSeconds(raw: string | null): number {
  if (!raw) return 0;
  const match = TIMESTAMP.exec(raw);
  if (!match || match[0] === "") return 0;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_START_SECONDS ? seconds : 0;
}

function youtubeEmbedFor(url: URL, host: string, segments: string[]): LinkEmbed | null {
  let id: string | undefined;
  if (host === YOUTUBE_SHORT_HOST) {
    if (segments.length === 1) id = segments[0];
  } else if (url.pathname === "/watch") {
    id = url.searchParams.get("v") ?? undefined;
  } else if (segments.length === 2 && YOUTUBE_PATHS.has(segments[0])) {
    id = segments[1];
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return { kind: "youtube", id, start: startSeconds(url.searchParams.get("t") ?? url.searchParams.get("start")) };
}

function xEmbedFor(segments: string[]): LinkEmbed | null {
  // /i/status/ID and /i/web/status/ID are share links that do not name the author.
  let rest = segments;
  let handle = "";
  if (rest[0] === "i") {
    rest = rest[1] === "web" ? rest.slice(2) : rest.slice(1);
  } else {
    if (!X_HANDLE.test(rest[0] ?? "")) return null;
    handle = rest[0];
    rest = rest.slice(1);
  }
  if (rest[0] !== "status" || !X_POST_ID.test(rest[1] ?? "")) return null;
  // The same post, opened on one of its pictures or its video.
  const tail = rest.slice(2);
  const isMediaTail = tail.length === 2 && (tail[0] === "photo" || tail[0] === "video") && /^\d$/.test(tail[1]);
  if (tail.length !== 0 && !isMediaTail) return null;
  return { kind: "x", id: rest[1], handle };
}

/** What this link can play in the chat, or null when it is an ordinary link. */
export function linkEmbedFor(rawUrl: string | null | undefined): LinkEmbed | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === YOUTUBE_SHORT_HOST || YOUTUBE_HOSTS.has(host)) return youtubeEmbedFor(url, host, segments);
  if (X_HOSTS.has(host)) return xEmbedFor(segments);
  return null;
}

/**
 * The player frame for a video. `autoplay` is for the moment the reader presses play: the
 * click that loads the player is the click to play. A player that is only coming back
 * into view must not start by itself.
 */
export function youtubePlayerUrl(id: string, start: number, autoplay: boolean): string {
  const url = new URL(`/embed/${encodeURIComponent(id)}`, "https://www.youtube-nocookie.com");
  if (autoplay) url.searchParams.set("autoplay", "1");
  url.searchParams.set("playsinline", "1");
  url.searchParams.set("rel", "0");
  if (start > 0) url.searchParams.set("start", String(Math.floor(start)));
  return url.toString();
}

/** The video's still picture. 4:3 with black bars; the card crops it to 16:9. */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

export const X_FRAME_ORIGIN = "https://platform.twitter.com";

/** X's own frame for one post. `dnt` asks X not to use the view for ad tracking. */
export function xPostFrameUrl(id: string): string {
  const url = new URL("/embed/Tweet.html", X_FRAME_ORIGIN);
  url.searchParams.set("id", id);
  url.searchParams.set("dnt", "true");
  url.searchParams.set("theme", "dark");
  return url.toString();
}

/** Height of an opened post until X's frame reports the real one. */
export const X_FRAME_START_PX = 320;
const X_FRAME_MIN_PX = 120;
const X_FRAME_MAX_PX = 900;

/**
 * The height X's frame reports for post `id`, from a `message` event; null for anything
 * else. Only the frame's own origin is believed, only for this post, and the height is
 * clamped so a frame can neither take over the chat nor shrink to nothing.
 */
export function xFrameHeight(origin: string, data: unknown, id: string): number | null {
  if (origin !== X_FRAME_ORIGIN) return null;
  let message: unknown = data;
  if (typeof data === "string") {
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof message !== "object" || message === null) return null;
  const call = (message as Record<string, unknown>)["twttr.embed"];
  if (typeof call !== "object" || call === null) return null;
  const { method, params } = call as { method?: unknown; params?: unknown };
  if (method !== "twttr.private.resize" || !Array.isArray(params)) return null;
  const first = params[0] as { height?: unknown; data?: { tweet_id?: unknown } } | undefined;
  if (!first || first.data?.tweet_id !== id) return null;
  if (typeof first.height !== "number" || !Number.isFinite(first.height)) return null;
  return Math.min(X_FRAME_MAX_PX, Math.max(X_FRAME_MIN_PX, Math.round(first.height)));
}

/** One link in one message: opening a video in one message leaves the others closed. */
export function embedKey(messageId: string, url: string): string {
  return `${messageId}|${url}`;
}

// ── Sizes (mirrored by the .kc-embed rules in index.css) ─────────────────────────────
const EMBED_GAP_PX = 6; // space above a card
const EMBED_CAPTION_PX = 44; // the bar under a video or a post
const EMBED_MAX_WIDTH_PX = 480;
const CHIP_BODY_PX = 56;
/** A link that has not been opened and has no preview: one small button row. */
export const EMBED_CHIP_PX = CHIP_BODY_PX + EMBED_GAP_PX;

export interface EmbedRowInputs {
  /** A picture and title may be shown before the click (never in an encrypted chat). */
  showPreview: boolean;
  /** Set once the reader has opened it. For a post on X it is the frame's height. */
  openHeight: number | undefined;
  /** Width of the message text column; 0 when the chat has not been measured yet. */
  textWidth: number;
}

function videoCardPx(textWidth: number): number {
  const width = textWidth > 0 ? Math.min(EMBED_MAX_WIDTH_PX, textWidth) : EMBED_MAX_WIDTH_PX;
  return Math.ceil((width * 9) / 16) + EMBED_CAPTION_PX + EMBED_GAP_PX;
}

/** How much height a link's card takes in its message row. */
export function embedRowPx(embed: LinkEmbed, { showPreview, openHeight, textWidth }: EmbedRowInputs): number {
  const isOpen = openHeight !== undefined;
  if (embed.kind === "youtube") {
    // With a preview, the closed card is the video's picture at the player's size.
    return isOpen || showPreview ? videoCardPx(textWidth) : EMBED_CHIP_PX;
  }
  return isOpen ? openHeight + EMBED_CAPTION_PX + EMBED_GAP_PX : EMBED_CHIP_PX;
}
