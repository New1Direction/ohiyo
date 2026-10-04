import { useEffect, useRef, useState } from "react";
import type { WatchSession } from "../gateway";
import { livePosition, youtubeId } from "../lib/watchSync";
import {
  YOUTUBE_EMBED_ORIGIN,
  YT_BUFFERING,
  YT_PAUSED,
  YT_PLAYING,
  parseYouTubeMessage,
  youtubeCommand,
  youtubeEmbedUrl,
  youtubeListening,
} from "../lib/youtubeEmbed";

type ControlFn = (action: string, payload?: { url?: string; position?: number }) => void;
type PlayerProps = { session: WatchSession; isHost: boolean; onControl: ControlFn };

const nowSeconds = () => Date.now() / 1000;

// How long our own play/pause/seek on the player is not mistaken for the user's.
const SUPPRESS_MS = 600;
// A player told to play that still isn't after this long was stopped by the browser's
// autoplay rules; the user has to click once.
const AUTOPLAY_CHECK_MS = 2000;

/** Covers the player when the browser refused to start playback without a click. */
function JoinOverlay({ onJoin }: { onJoin: () => void }) {
  return (
    <button
      type="button"
      onClick={onJoin}
      className="kc-interactive"
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.6)",
        color: "#fff",
        border: "none",
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      ▶ Click to join the party
    </button>
  );
}

// ── Direct media (<video>) ────────────────────────────────────────────────────
function DirectVideo({ session, isHost, onControl }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const suppressRef = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [blocked, setBlocked] = useState(false);

  /** Put this player where the shared session says it should be. */
  function sync() {
    const v = videoRef.current;
    if (!v) return;
    const s = sessionRef.current;
    suppressRef.current = true;
    const target = Math.max(0, livePosition(s, nowSeconds()));
    if (Number.isFinite(target) && Math.abs(v.currentTime - target) > 0.5) v.currentTime = target;
    // Past the end there is nothing to play; play() there would restart from the top.
    const pastEnd = Number.isFinite(v.duration) && target >= v.duration - 0.25;
    if (s.paused || pastEnd) v.pause();
    else {
      void v
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    }
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      suppressRef.current = false;
    }, SUPPRESS_MS);
  }

  useEffect(() => {
    sync();
    return () => window.clearTimeout(suppressTimer.current);
  }, [session]);

  const onUserAction = (action: "play" | "pause" | "seek") => {
    if (suppressRef.current) return;
    // Only the host drives the party (the server ignores everyone else), so a guest who
    // pauses or scrubs is put straight back in step instead of drifting off alone.
    if (!isHost) {
      sync();
      return;
    }
    onControl(action, { position: videoRef.current?.currentTime ?? 0 });
  };

  return (
    <div style={{ position: "relative" }}>
      <video
        ref={videoRef}
        src={session.url}
        controls
        playsInline
        style={{ width: "100%", maxHeight: 360, display: "block", background: "#000" }}
        onPlay={() => onUserAction("play")}
        onPause={() => onUserAction("pause")}
        onSeeked={() => onUserAction("seek")}
      />
      {blocked && <JoinOverlay onJoin={sync} />}
    </div>
  );
}

// ── YouTube (an <iframe> driven by postMessage; see lib/youtubeEmbed.ts) ───────
function YouTubeWatch({ videoId, session, isHost, onControl }: PlayerProps & { videoId: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const suppressRef = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);
  const autoplayTimer = useRef<number | undefined>(undefined);
  const listenTimer = useRef<number | undefined>(undefined);
  const stateRef = useRef<number | null>(null);
  // The last position the player reported, and when (ms), to estimate where it is now.
  const timeRef = useRef({ time: 0, at: 0 });
  // Always act on the latest props (the message listener is set up once per video).
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const [blocked, setBlocked] = useState(false);

  const post = (message: string) => frameRef.current?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);

  const playerTime = () => {
    const { time, at } = timeRef.current;
    return stateRef.current === YT_PLAYING ? time + (Date.now() - at) / 1000 : time;
  };

  /** Put this player where the shared session says it should be. */
  function sync() {
    if (!readyRef.current) return;
    const s = sessionRef.current;
    suppressRef.current = true;
    const target = Math.max(0, livePosition(s, nowSeconds()));
    if (Math.abs(playerTime() - target) > 1) post(youtubeCommand("seekTo", [target, true]));
    post(youtubeCommand(s.paused ? "pauseVideo" : "playVideo"));
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      suppressRef.current = false;
    }, SUPPRESS_MS);
    window.clearTimeout(autoplayTimer.current);
    if (!s.paused) {
      autoplayTimer.current = window.setTimeout(() => {
        const playing = stateRef.current === YT_PLAYING || stateRef.current === YT_BUFFERING;
        if (!sessionRef.current.paused && !playing) setBlocked(true);
      }, AUTOPLAY_CHECK_MS);
    }
  }

  // Listen to the player for as long as this video is shown.
  useEffect(() => {
    readyRef.current = false;
    stateRef.current = null;
    timeRef.current = { time: 0, at: 0 };

    const onState = (state: number) => {
      if (state === YT_PLAYING) setBlocked(false);
      if (suppressRef.current || (state !== YT_PLAYING && state !== YT_PAUSED)) return;
      // Only the host drives the party; a guest who pauses or scrubs is put back in step.
      if (!isHostRef.current) {
        sync();
        return;
      }
      onControlRef.current(state === YT_PLAYING ? "play" : "pause", { position: playerTime() });
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const update = parseYouTubeMessage(e.origin, e.data);
      if (!update) return;
      window.clearInterval(listenTimer.current);
      if (typeof update.time === "number") {
        const jumped = Math.abs(update.time - timeRef.current.time) > 1.5;
        timeRef.current = { time: update.time, at: Date.now() };
        // The host scrubbing while paused changes the time without changing the state.
        if (jumped && readyRef.current && !suppressRef.current && stateRef.current === YT_PAUSED) {
          if (isHostRef.current) onControlRef.current("seek", { position: update.time });
          else sync();
        }
      }
      if (update.ready && !readyRef.current) {
        readyRef.current = true;
        post(youtubeCommand("addEventListener", ["onStateChange"]));
        sync();
      }
      if (typeof update.state === "number" && update.state !== stateRef.current) {
        stateRef.current = update.state;
        if (readyRef.current) onState(update.state);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(listenTimer.current);
      window.clearTimeout(suppressTimer.current);
      window.clearTimeout(autoplayTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one listener per video; it reads the latest props from refs
  }, [videoId]);

  // Re-sync to the room whenever the shared session changes.
  useEffect(() => {
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync reads the latest session from a ref
  }, [session]);

  // The player only starts reporting once it has been asked; it ignores the request
  // until it has loaded, so keep asking until it answers.
  const startListening = () => {
    window.clearInterval(listenTimer.current);
    let tries = 0;
    listenTimer.current = window.setInterval(() => {
      post(youtubeListening());
      if (++tries >= 40) window.clearInterval(listenTimer.current);
    }, 250);
  };

  const pageOrigin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", background: "#000" }}>
      <iframe
        ref={frameRef}
        src={youtubeEmbedUrl(videoId, pageOrigin)}
        title="Watch party video"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={startListening}
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
      {blocked && <JoinOverlay onJoin={sync} />}
    </div>
  );
}

/**
 * A channel-synced watch party. The member who started it is the host: their
 * play/pause/seek syncs everyone, and only they can end it. Supports YouTube (an embed
 * driven by messages) and direct media URLs.
 */
export function WatchParty({ session, isHost, onControl }: PlayerProps) {
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
        {isHost ? (
          <button
            type="button"
            onClick={() => onControl("stop")}
            className="kc-interactive rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
          >
            End
          </button>
        ) : (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Only the host controls playback
          </span>
        )}
      </div>
      {ytId ? (
        <YouTubeWatch key={ytId} videoId={ytId} session={session} isHost={isHost} onControl={onControl} />
      ) : (
        <DirectVideo key={session.url} session={session} isHost={isHost} onControl={onControl} />
      )}
    </div>
  );
}
