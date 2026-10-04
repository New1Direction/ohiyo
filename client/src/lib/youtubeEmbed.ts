// A YouTube player embedded as an <iframe> and driven by postMessage. Nothing from
// YouTube runs in this page: the IFrame API script (https://www.youtube.com/iframe_api)
// would need `script-src` opened to a third party and would run inside the app.

export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

// Player states the embed reports.
export const YT_ENDED = 0;
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

// ── The player's position ─────────────────────────────────────────────────────
// The embed reports its position only while it changes (nothing arrives while paused or
// stalled), so the app keeps the last report, when it came, and the player state.
export type PlayerClock = { time: number; at: number; state: number | null };

export const NEW_PLAYER_CLOCK: PlayerClock = { time: 0, at: 0, state: null };

// A reported position this far from where the player should be is a seek, not jitter.
const JUMP_SECONDS = 1.5;

/** Where the player is at `nowMs`: it only moves on from the last report while playing. */
export function playerTimeAt(clock: PlayerClock, nowMs: number): number {
  return clock.state === YT_PLAYING ? clock.time + (nowMs - clock.at) / 1000 : clock.time;
}

/**
 * The clock after a message from the player. A new state first fixes the position
 * reached under the old one, so a pause or a stall is never counted as playback when the
 * player starts again. `jumped` is true when the reported position is not where the
 * player should have been: someone scrubbed.
 */
export function advanceClock(
  clock: PlayerClock,
  update: YouTubeUpdate,
  nowMs: number
): { clock: PlayerClock; jumped: boolean; stateChanged: boolean } {
  let next = clock;
  let jumped = false;
  if (typeof update.time === "number") {
    jumped = Math.abs(update.time - playerTimeAt(clock, nowMs)) > JUMP_SECONDS;
    next = { ...next, time: update.time, at: nowMs };
  }
  const stateChanged = typeof update.state === "number" && update.state !== clock.state;
  if (stateChanged) next = { time: playerTimeAt(next, nowMs), at: nowMs, state: update.state as number };
  return { clock: next, jumped, stateChanged };
}

/**
 * What a new player state means for the party. The host's play and pause drive everyone
 * (reaching the end is a pause there); a guest who plays or pauses is put back in step.
 */
export function youtubeControlFor(state: number, isHost: boolean): "play" | "pause" | "resync" | null {
  if (state === YT_PLAYING) return isHost ? "play" : "resync";
  if (state === YT_PAUSED) return isHost ? "pause" : "resync";
  if (state === YT_ENDED) return isHost ? "pause" : null;
  return null;
}

/** A player told to play that is in one of these states was not stopped by autoplay rules. */
export function countsAsPlaying(state: number | null): boolean {
  return state === YT_PLAYING || state === YT_BUFFERING || state === YT_ENDED;
}
