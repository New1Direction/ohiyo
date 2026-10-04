// Watch party timing. The server holds the session (position, and when that position was
// true on its own clock); every client works out the live position from it.
import type { WatchSession } from "../gateway.ts";

/** Extract a YouTube video id from a watch/share/embed/shorts URL, else null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname === "youtube.com" || u.hostname.endsWith(".youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const seg = u.pathname.split("/");
      if (seg[1] === "embed" || seg[1] === "shorts") return seg[2] || null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

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
