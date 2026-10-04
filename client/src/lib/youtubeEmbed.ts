// A YouTube player embedded as an <iframe> and driven by postMessage. Nothing from
// YouTube runs in this page: the IFrame API script (https://www.youtube.com/iframe_api)
// would need `script-src` opened to a third party and would run inside the app.

export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

// Player states the embed reports.
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;

/** The embed URL for a video. `pageOrigin` tells the player which parent may drive it. */
export function youtubeEmbedUrl(videoId: string, pageOrigin: string): string {
  const url = new URL(`/embed/${encodeURIComponent(videoId)}`, YOUTUBE_EMBED_ORIGIN);
  url.searchParams.set("enablejsapi", "1");
  url.searchParams.set("playsinline", "1");
  url.searchParams.set("rel", "0");
  url.searchParams.set("origin", pageOrigin);
  return url.toString();
}

// The player's message envelope. `id` and `channel` are what its own API sends.
const envelope = (body: Record<string, unknown>): string => JSON.stringify({ ...body, id: 1, channel: "widget" });

/** Ask the player to start reporting. Sent until it answers (it ignores early ones). */
export const youtubeListening = (): string => envelope({ event: "listening" });

/** A player command such as playVideo, pauseVideo or seekTo. */
export const youtubeCommand = (func: string, args: unknown[] = []): string => envelope({ event: "command", func, args });

/** What a message from the player says: it is ready, its state changed, where it is. */
export type YouTubeUpdate = { ready?: true; state?: number; time?: number };

/** Read a `message` event from the embed; null when it is not from the player. */
export function parseYouTubeMessage(origin: string, data: unknown): YouTubeUpdate | null {
  if (origin !== YOUTUBE_EMBED_ORIGIN) return null;
  let msg: unknown = data;
  if (typeof data === "string") {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof msg !== "object" || msg === null) return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event === "onReady") return { ready: true };
  if (event === "onStateChange") return typeof info === "number" ? { state: info } : {};
  if (event === "initialDelivery" || event === "infoDelivery") {
    const out: YouTubeUpdate = {};
    if (typeof info === "object" && info !== null) {
      const { playerState, currentTime } = info as { playerState?: unknown; currentTime?: unknown };
      if (typeof playerState === "number") out.state = playerState;
      if (typeof currentTime === "number") out.time = currentTime;
    }
    return out;
  }
  return null;
}
