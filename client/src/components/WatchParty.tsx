import { useEffect, useRef } from "react";
import type { WatchSession } from "../gateway";

type Props = {
  session: WatchSession;
  onControl: (action: string, payload?: { url?: string; position?: number }) => void;
};

/** Live playback position (seconds), accounting for elapsed time when playing. */
function livePosition(s: WatchSession): number {
  return s.paused ? s.position : s.position + (Date.now() / 1000 - s.updated_at);
}

/**
 * A channel-synced video player. Anyone's play/pause/seek broadcasts and syncs
 * everyone. v1 plays direct media URLs (.mp4/.webm/HLS); YouTube embeds are a
 * follow-up (they need the IFrame API for playback sync).
 */
export function WatchParty({ session, onControl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Ignore the play/pause/seek events our own programmatic sync triggers.
  const suppressRef = useRef(false);

  // Re-sync the local <video> whenever the shared session changes.
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
    </div>
  );
}
