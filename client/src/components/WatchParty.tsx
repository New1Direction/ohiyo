import { useEffect, useRef } from "react";
import type { WatchSession } from "../gateway";

type ControlFn = (action: string, payload?: { url?: string; position?: number }) => void;

// ── YouTube IFrame API (loaded on demand, typed minimally) ────────────────────
type YTPlayer = {
  getCurrentTime?: () => number;
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo?: () => void;
  pauseVideo?: () => void;
  destroy?: () => void;
};
type YTNamespace = {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number };
};
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

/** Extract a YouTube video id from a watch/share/embed/shorts URL, else null. */
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const seg = u.pathname.split("/");
      if (seg[1] === "embed" || seg[1] === "shorts") return seg[2] || null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Live playback position (seconds), accounting for elapsed time when playing. */
function livePosition(s: WatchSession): number {
  return s.paused ? s.position : s.position + (Date.now() / 1000 - s.updated_at);
}

// ── Direct media (<video>) ────────────────────────────────────────────────────
function DirectVideo({ session, onControl }: { session: WatchSession; onControl: ControlFn }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const suppressRef = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    suppressRef.current = true;
    const target = livePosition(session);
    if (Number.isFinite(target) && Math.abs(v.currentTime - target) > 0.5) {
      v.currentTime = Math.max(0, target);
    }
    if (session.paused) v.pause();
    else void v.play().catch(() => {});
    const t = window.setTimeout(() => {
      suppressRef.current = false;
    }, 350);
    return () => window.clearTimeout(t);
  }, [session]);

  const emit = (action: string) => {
    if (suppressRef.current) return;
    onControl(action, { position: videoRef.current?.currentTime ?? 0 });
  };

  return (
    <video
      ref={videoRef}
      src={session.url}
      controls
      playsInline
      style={{ width: "100%", maxHeight: 360, display: "block", background: "#000" }}
      onPlay={() => emit("play")}
      onPause={() => emit("pause")}
      onSeeked={() => emit("seek")}
    />
  );
}

// ── YouTube (IFrame API) ──────────────────────────────────────────────────────
function YouTubeWatch({
  videoId,
  session,
  onControl,
}: {
  videoId: string;
  session: WatchSession;
  onControl: ControlFn;
}) {
  const hostRef = useRef<HTMLDivElement>(null); // disposable node the API replaces
  const playerRef = useRef<YTPlayer | null>(null);
  const suppressRef = useRef(false);
  const readyRef = useRef(false);
  // Always sync against the latest session (avoid stale closures in YT callbacks).
  const sessionRef = useRef(session);
  sessionRef.current = session;

  function syncToSession() {
    const p = playerRef.current;
    if (!p) return;
    const s = sessionRef.current;
    suppressRef.current = true;
    const target = s.paused ? s.position : s.position + (Date.now() / 1000 - s.updated_at);
    const cur = p.getCurrentTime?.() ?? 0;
    if (Math.abs(cur - target) > 1) p.seekTo?.(Math.max(0, target), true);
    if (s.paused) p.pauseVideo?.();
    else p.playVideo?.();
    window.setTimeout(() => {
      suppressRef.current = false;
    }, 600);
  }

  // Build the player once per video.
  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    void loadYouTubeApi().then(() => {
      if (cancelled || !hostRef.current || !window.YT) return;
      playerRef.current = new window.YT.Player(hostRef.current, {
        videoId,
        playerVars: { autoplay: 0, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            readyRef.current = true;
            syncToSession();
          },
          onStateChange: (e: { data: number }) => {
            if (suppressRef.current || !window.YT) return;
            const pos = playerRef.current?.getCurrentTime?.() ?? 0;
            if (e.data === window.YT.PlayerState.PLAYING) onControl("play", { position: pos });
            else if (e.data === window.YT.PlayerState.PAUSED) onControl("pause", { position: pos });
          },
        },
      });
    });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only when the video changes; syncToSession/onControl read live refs
  }, [videoId]);

  // Re-sync to the room whenever the shared session changes.
  useEffect(() => {
    if (readyRef.current) syncToSession();
  }, [session]);

  return (
    <div style={{ width: "100%", aspectRatio: "16 / 9", background: "#000" }}>
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

/**
 * A channel-synced watch party. Anyone's play/pause/seek broadcasts and syncs
 * everyone. Supports YouTube (IFrame API) and direct media URLs.
 */
export function WatchParty({ session, onControl }: { session: WatchSession; onControl: ControlFn }) {
  const ytId = youtubeId(session.url);
  return (
    <div
      className="kc-watch"
      style={{
        margin: "8px 12px 0",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        background: "var(--bg-sidebar)",
        border: "1px solid var(--bg-hover)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div className="flex items-center justify-between gap-2" style={{ padding: "8px 12px" }}>
        <span className="flex items-center gap-1.5 text-sm" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          📺 Watch party
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: session.paused ? "var(--text-muted)" : "var(--green)",
            }}
          >
            {session.paused ? "Paused" : "● Live"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onControl("stop")}
          className="kc-interactive rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
        >
          End
        </button>
      </div>
      {ytId ? (
        <YouTubeWatch videoId={ytId} session={session} onControl={onControl} />
      ) : (
        <DirectVideo session={session} onControl={onControl} />
      )}
    </div>
  );
}
