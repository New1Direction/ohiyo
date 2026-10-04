// Watch party timing. The server holds the session (position, and when that position was
// true on its own clock); every client works out the live position from it.
import type { WatchSession } from "../gateway.ts";

/** Extract a YouTube video id from a watch/share/embed/shorts URL, else null. */
export function youtubeId(url: string): string | null {
  let id: string | null | undefined;
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    else if (u.hostname === "youtube.com" || u.hostname.endsWith(".youtube.com")) {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const seg = u.pathname.split("/");
        if (seg[1] === "embed" || seg[1] === "shorts") id = seg[2];
      }
    }
  } catch {
    /* not a URL */
  }
  // The id goes into the embed's path: anything else (".." above all) is not a video.
  return id && YOUTUBE_ID.test(id) ? id : null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The session with `updated_at` moved onto this device's clock. `server_time` is the
 * server's clock when it sent the session, so the difference from `nowSeconds` is how far
 * this device's clock is off (plus the trip here). A session from a server that doesn't
 * send it is returned unchanged.
 */
export function onLocalClock(session: WatchSession, nowSeconds: number): WatchSession {
  if (!session.server_time) return session;
  return { ...session, updated_at: session.updated_at + (nowSeconds - session.server_time) };
}

/** Live playback position in seconds, for a session already on this device's clock. */
export function livePosition(session: WatchSession, nowSeconds: number): number {
  return session.paused ? session.position : session.position + (nowSeconds - session.updated_at);
}

/** Only the member who started the party drives it; the server ignores everyone else. */
export function isWatchHost(session: WatchSession, userId: string | null | undefined): boolean {
  return Boolean(userId) && session.host_id === userId;
}

// The host's own play or seek comes back from the server a round trip later, by which
// time its player has moved on. It must not rewind itself for that, only for a real
// change (another tab of the same host, rejoining a running party).
const HOST_ECHO_SECONDS = 3;

/** Whether a player at `current` has to be moved to reach `target`. */
export function needsSeek(current: number, target: number, isHost: boolean, tolerance: number): boolean {
  return Math.abs(current - target) > (isHost ? Math.max(tolerance, HOST_ECHO_SECONDS) : tolerance);
}

/**
 * Whether a rejected `play()` means the browser refused to start playback without a
 * click. `pause()` interrupting `play()` (AbortError) or a URL that isn't media
 * (NotSupportedError) are not that, and a click would not help.
 */
export function isAutoplayBlock(err: unknown): boolean {
  return err instanceof Error && err.name === "NotAllowedError";
}
