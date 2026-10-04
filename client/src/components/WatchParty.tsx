import { useEffect, useRef, useState } from "react";
import { DreamGestures } from "./DreamGestures";
import { useWatchDream } from "../hooks/useWatchDream";
import type { WatchSession } from "../gateway";
import { isAutoplayBlock, livePosition, needsSeek, youtubeId } from "../lib/watchSync";
import {
  NEW_PLAYER_CLOCK,
  YOUTUBE_EMBED_ORIGIN,
  YT_PLAYING,
  advanceClock,
  countsAsPlaying,
  parseYouTubeMessage,
  playerTimeAt,
  youtubeCommand,
  youtubeControlFor,
  youtubeEmbedUrl,
  youtubeListening,
  type PlayerClock,
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
  // sync() runs from an effect and from event handlers: it reads the latest props here.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const [blocked, setBlocked] = useState(false);

  /** Put this player where the shared session says it should be. */
  function sync() {
    const v = videoRef.current;
    if (!v) return;
    const s = sessionRef.current;
    suppressRef.current = true;
    const target = Math.max(0, livePosition(s, nowSeconds()));
    if (Number.isFinite(target) && needsSeek(v.currentTime, target, isHostRef.current, 0.5)) v.currentTime = target;
    // Past the end there is nothing to play; play() there would restart from the top.
    const pastEnd = Number.isFinite(v.duration) && target >= v.duration - 0.25;
    if (s.paused || pastEnd) {
      v.pause();
      if (s.paused) setBlocked(false);
    } else {
      void v
        .play()
        .then(() => setBlocked(false))
        .catch((err: unknown) => {
          // Not pause() cutting play() short, and not a URL that isn't media.
          if (isAutoplayBlock(err)) setBlocked(true);
        });
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
  // The player's last reported position and state, to work out where it is now.
  const clockRef = useRef<PlayerClock>(NEW_PLAYER_CLOCK);
  // Always act on the latest props (the message listener is set up once per video).
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const [blocked, setBlocked] = useState(false);

  const post = (message: string) => frameRef.current?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);

  const playerTime = () => playerTimeAt(clockRef.current, Date.now());

  /** Put this player where the shared session says it should be. */
  function sync() {
    if (!readyRef.current) return;
    const s = sessionRef.current;
    suppressRef.current = true;
    const target = Math.max(0, livePosition(s, nowSeconds()));
    if (needsSeek(playerTime(), target, isHostRef.current, 1)) post(youtubeCommand("seekTo", [target, true]));
    post(youtubeCommand(s.paused ? "pauseVideo" : "playVideo"));
    if (s.paused) setBlocked(false);
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      suppressRef.current = false;
    }, SUPPRESS_MS);
    window.clearTimeout(autoplayTimer.current);
    if (!s.paused) {
      autoplayTimer.current = window.setTimeout(() => {
        if (!sessionRef.current.paused && !countsAsPlaying(clockRef.current.state)) setBlocked(true);
      }, AUTOPLAY_CHECK_MS);
    }
  }

  // Listen to the player for as long as this video is shown.
  useEffect(() => {
    readyRef.current = false;
    clockRef.current = NEW_PLAYER_CLOCK;

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const update = parseYouTubeMessage(e.origin, e.data);
      if (!update) return;
      window.clearInterval(listenTimer.current);
      const { clock, jumped, stateChanged } = advanceClock(clockRef.current, update, Date.now());
      clockRef.current = clock;
      if (stateChanged && clock.state === YT_PLAYING) setBlocked(false);
      if (update.ready && !readyRef.current) {
        readyRef.current = true;
        post(youtubeCommand("addEventListener", ["onStateChange"]));
        sync();
        return;
      }
      // Our own commands move the player too; those are not the user's doing.
      if (!readyRef.current || suppressRef.current) return;
      if (stateChanged && clock.state !== null) {
        // Only the host drives the party; a guest who pauses or plays is put back in step.
        const action = youtubeControlFor(clock.state, isHostRef.current);
        if (action === "resync") sync();
        else if (action) onControlRef.current(action, { position: playerTime() });
      } else if (jumped) {
        // Scrubbing moves the position without always changing the state.
        if (isHostRef.current) onControlRef.current("seek", { position: clock.time });
        else sync();
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
  const [dream, setDream] = useState(false);
  const [cinema, setCinema] = useState(false);
  const [modeError, setModeError] = useState("");
  const playerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [volumeNotice, setVolumeNotice] = useState("");
  const volumeCheck = useRef<number | undefined>(undefined);
  const reportedVolume = useRef<number | null>(null);

  // Read only the public player message contract, never cross-origin frame pixels.
  useEffect(() => {
    reportedVolume.current = null;
    setVolume(null);
    setVolumeNotice("");
    const video = playerRef.current?.querySelector("video");
    const updateNative = () => {
      if (video) { reportedVolume.current = video.volume * 100; setVolume(video.volume * 100); }
    };
    updateNative();
    video?.addEventListener("volumechange", updateNative);
    const onMessage = (event: MessageEvent) => {
      const frame = playerRef.current?.querySelector("iframe");
      if (!frame || event.source !== frame.contentWindow) return;
      const update = parseYouTubeMessage(event.origin, event.data);
      if (typeof update?.volume === "number") {
        reportedVolume.current = update.volume;
        setVolume(update.volume);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      video?.removeEventListener("volumechange", updateNative);
      window.clearTimeout(volumeCheck.current);
    };
  }, [session.url]);

  const changeVolume = (requested: number) => {
    const next = Math.max(0, Math.min(100, Math.round(requested)));
    const video = playerRef.current?.querySelector("video");
    const frame = playerRef.current?.querySelector("iframe");
    setVolumeNotice("");
    if (video) {
      video.volume = next / 100;
      if (Math.abs(video.volume * 100 - next) > 1) {
        setVolumeNotice("Use your device volume buttons in this browser.");
        return;
      }
      reportedVolume.current = next;
    } else if (frame) {
      frame.contentWindow?.postMessage(youtubeCommand("setVolume", [next]), YOUTUBE_EMBED_ORIGIN);
    }
    // Never automatically unmute the player. Native/provider mute remains the user's choice.
    setVolume(next);
    window.clearTimeout(volumeCheck.current);
    volumeCheck.current = window.setTimeout(() => {
      if (reportedVolume.current !== null && Math.abs(reportedVolume.current - next) > 2) {
        setVolume(reportedVolume.current);
        setVolumeNotice("Use the video's controls or your device volume buttons.");
      }
    }, 1200);
  };
  const togglePlayback = () => {
    if (!isHost) return;
    const native = playerRef.current?.querySelector("video");
    onControl(session.paused ? "play" : "pause", {
      position: native?.currentTime ?? Math.max(0, livePosition(session, nowSeconds())),
    });
  };
  useWatchDream(playerRef, toggleRef, dream, () => setDream(false));

  useEffect(() => {
    const player = playerRef.current;
    const onFullscreen = () => {
      const active = document.fullscreenElement === playerRef.current;
      setCinema(active);
      if (active) setDream(false);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (document.fullscreenElement === player) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleCinema = async () => {
    setModeError("");
    try {
      if (document.fullscreenElement === playerRef.current) {
        await document.exitFullscreen();
      } else if (playerRef.current?.requestFullscreen) {
        // Must run directly from the click gesture. Never move/remount the iframe.
        await playerRef.current.requestFullscreen();
      } else {
        setModeError("Cinema fullscreen is not available in this browser.");
      }
    } catch {
      setModeError("Fullscreen was not allowed. Try Cinema again or use the video's fullscreen control.");
    }
  };
  const toggleDream = async () => {
    setModeError("");
    if (document.fullscreenElement === playerRef.current) {
      try { await document.exitFullscreen(); }
      catch { setModeError("Leave fullscreen first to use Dream mode."); return; }
    }
    setDream((value) => !value);
  };
  return (
    <div
      ref={playerRef}
      className={`kc-watch${dream ? " kc-watch--dream" : ""}${cinema ? " kc-watch--cinema" : ""}`}
    >
      {dream && <div className="kc-watch-ambient" aria-hidden="true">
        {ytId && <img src={`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`} alt="" referrerPolicy="no-referrer" />}
      </div>}
      <div className="kc-watch-header flex flex-wrap items-center justify-between gap-2" >
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={toggleRef}
            type="button"
            aria-pressed={dream}
            title={dream ? "Leave Dream mode (Esc)" : "Soft room lighting from the video thumbnail"}
            onClick={() => void toggleDream()}
            className="kc-interactive kc-watch-dream-toggle rounded-full px-2.5 py-1 text-xs font-semibold"
          >
            <span aria-hidden="true">☾ </span>Dream mode
          </button>
          <button
            type="button"
            aria-pressed={cinema}
            title={cinema ? "Leave fullscreen Cinema" : "Fullscreen video with a black surround"}
            onClick={() => void toggleCinema()}
            className="kc-interactive kc-watch-dream-toggle rounded-full px-2.5 py-1 text-xs font-semibold"
          >
            {cinema ? "Exit Cinema" : "Cinema"}
          </button>
          {isHost ? (
            <button
              type="button"
              onClick={() => { setDream(false); onControl("stop"); }}
              className="kc-interactive kc-watch-dream-toggle rounded-full px-2.5 py-1 text-xs font-semibold"
            >
              End
            </button>
          ) : (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Only the host controls playback
            </span>
          )}
        </div>
      </div>
      {modeError && <p className="kc-watch-mode-error" role="status">{modeError}</p>}
      <div className="kc-watch-media">
        {ytId ? (
          <YouTubeWatch key={ytId} videoId={ytId} session={session} isHost={isHost} onControl={onControl} />
        ) : (
          <DirectVideo key={session.url} session={session} isHost={isHost} onControl={onControl} />
        )}

      </div>
      {dream && <DreamGestures volume={volume} onVolumeChange={changeVolume} onTogglePlayback={togglePlayback} isHost={isHost} paused={session.paused} />}
      {dream && volumeNotice && <p className="kc-watch-volume-notice" role="status">{volumeNotice}</p>}
    </div>
  );
}
