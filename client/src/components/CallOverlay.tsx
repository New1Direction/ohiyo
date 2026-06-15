import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicUser } from "../api";
import type { UseWebRTCReturn } from "../hooks/useWebRTC";
import { ConnectionBadge } from "./ConnectionBadge";
import type { QualityLevel } from "../webrtc/quality";
import {
  SCREEN_SHARE_PRESETS,
  DEFAULT_PRESET_ID,
  supportsDisplayAudio,
  type ScreenSharePresetId,
} from "../webrtc/screenShare";

type Props = {
  webrtc: UseWebRTCReturn;
  currentUser: PublicUser | null;
  channelName: string;
};

// ── Icons (simple stroke set) ──────────────────────────────────────────────────
const Icon = {
  mic: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4",
  micOff: "M3 3l18 18 M9 9v2a3 3 0 0 0 4.5 2.6 M15 11V5a3 3 0 0 0-5.7-1.3 M5 10v1a7 7 0 0 0 11 5.5 M12 18v4",
  video: "M15 10l5-3v10l-5-3v-4z M3 6h12v12H3z",
  videoOff: "M3 3l18 18 M10 6h5v3 M15 13v5H4a1 1 0 0 1-1-1V7",
  screen: "M3 4h18v12H3z M8 20h8 M12 16v4",
  hangup: "M3 11a17 17 0 0 1 18 0l-2.5 3a2 2 0 0 1-2.3.5l-2-1a2 2 0 0 1-1.2-1.8v-1a11 11 0 0 0-4 0v1a2 2 0 0 1-1.2 1.8l-2 1a2 2 0 0 1-2.3-.5L3 11z",
};

function StrokeIcon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {d.split(" M").map((seg, i) => <path key={i} d={(i === 0 ? seg : "M" + seg)} />)}
    </svg>
  );
}

// ── A single participant tile ──────────────────────────────────────────────────
function VideoTile({
  stream, name, avatarUrl, muted, video, screen, isSelf, quality,
}: {
  stream: MediaStream | null;
  name: string;
  avatarUrl: string | null;
  muted: boolean;
  video: boolean;
  screen: boolean;
  isSelf: boolean;
  quality?: QualityLevel;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream ?? null;
    return () => { video.srcObject = null; };
  }, [stream]);

  const showVideo = (video || screen) && !!stream;
  const initial = name.charAt(0).toUpperCase();

  return (
    <div
      className="kc-card"
      style={{
        position: "relative", overflow: "hidden", aspectRatio: "16 / 10",
        background: "var(--bg-input)", borderRadius: "var(--radius-lg)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "var(--shadow-md)", minHeight: 0,
      }}
    >
      {showVideo ? (
        <video
          ref={ref} autoPlay playsInline muted={isSelf}
          style={{
            width: "100%", height: "100%", objectFit: screen ? "contain" : "cover",
            transform: isSelf && !screen ? "scaleX(-1)" : "none",
            background: "#000",
          }}
        />
      ) : (
        <div style={{
          width: 88, height: 88, borderRadius: "var(--radius-full)",
          background: "var(--accent)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "2rem",
          backgroundImage: avatarUrl ? `url(${avatarUrl})` : undefined,
          backgroundSize: "cover", backgroundPosition: "center",
        }}>
          {!avatarUrl && initial}
        </div>
      )}

      {/* Name + state chip */}
      <div style={{
        position: "absolute", left: "var(--space-2)", bottom: "var(--space-2)",
        display: "flex", alignItems: "center", gap: 6,
        padding: "4px 10px", borderRadius: "var(--radius-full)",
        background: "rgba(0,0,0,0.55)", color: "#fff",
        fontSize: "var(--text-sm)", fontWeight: 600, backdropFilter: "blur(6px)",
      }}>
        <span style={{ color: muted ? "var(--danger)" : "#7CF2B0" }}>
          <StrokeIcon d={muted ? Icon.micOff : Icon.mic} size={14} />
        </span>
        {name}{isSelf && " (you)"}{screen && " · sharing"}
        {quality && <ConnectionBadge level={quality} size={13} />}
      </div>
    </div>
  );
}

// ── Screen-share quality picker ───────────────────────────────────────────────
function SharePresetSheet({
  onShare, onClose,
}: {
  onShare: (presetId: ScreenSharePresetId, wantAudio: boolean) => void;
  onClose: () => void;
}) {
  const [presetId, setPresetId] = useState<ScreenSharePresetId>(DEFAULT_PRESET_ID);
  const [wantAudio, setWantAudio] = useState(false);
  const audioSupported = supportsDisplayAudio();

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- dismiss scrim; clicking the backdrop closes the sheet
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed", inset: 0, zIndex: 9100,
        background: "color-mix(in oklch, var(--bg-base) 40%, transparent)",
        backdropFilter: "blur(20px)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        paddingBottom: "calc(var(--space-12) + var(--space-6))",
      }}
    >
      <div
        className="kc-fade-up"
        style={{
          width: "min(560px, 92vw)", background: "var(--bg-channel)",
          borderRadius: "var(--radius-xl)", padding: "var(--space-5)",
          boxShadow: "var(--shadow-lg)", border: "1px solid var(--bg-hover)",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-lg)", marginBottom: "var(--space-1)" }}>
          Share your screen
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
          Pick a quality — all free, no Nitro.
        </div>

        <div role="radiogroup" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-2)" }}>
          {SCREEN_SHARE_PRESETS.map((p) => {
            const selected = p.id === presetId;
            return (
              <button
                key={p.id} role="radio" aria-checked={selected}
                onClick={() => setPresetId(p.id)}
                className="kc-interactive"
                style={{
                  textAlign: "left", border: "none", cursor: "pointer",
                  background: "var(--bg-input)", borderRadius: "var(--radius-lg)",
                  padding: "var(--space-3)",
                  boxShadow: selected ? "0 0 0 2px var(--accent), var(--shadow-md)" : "none",
                  transform: selected ? "scale(1.02)" : "none",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>{p.label}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 2 }}>{p.blurb}</div>
              </button>
            );
          })}
        </div>

        <label style={{
          display: "flex", alignItems: "center", gap: "var(--space-2)",
          marginTop: "var(--space-4)", cursor: audioSupported ? "pointer" : "not-allowed",
          opacity: audioSupported ? 1 : 0.55,
        }}>
          <input type="checkbox" checked={wantAudio && audioSupported} disabled={!audioSupported}
            onChange={(e) => setWantAudio(e.target.checked)} />
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>Share system audio</span>
          {!audioSupported && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
              — not available in this browser
            </span>
          )}
        </label>

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-5)", justifyContent: "flex-end" }}>
          <button onClick={onClose} className="kc-interactive"
            style={{ border: "none", background: "var(--bg-input)", color: "var(--text-secondary)",
              borderRadius: "var(--radius-md)", padding: "10px 18px", cursor: "pointer", fontWeight: 600, fontSize: "var(--text-sm)" }}>
            Cancel
          </button>
          <button onClick={() => onShare(presetId, wantAudio)} className="kc-cta"
            style={{ padding: "10px 22px", fontSize: "var(--text-sm)", cursor: "pointer" }}>
            Start sharing
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Control button ──────────────────────────────────────────────────────────────
function ControlBtn({
  d, label, onClick, active, danger,
}: {
  d: string; label: string; onClick: () => void; active?: boolean; danger?: boolean;
}) {
  const bg = danger ? "var(--danger)" : active ? "var(--accent)" : "var(--bg-input)";
  const color = danger || active ? "#fff" : "var(--text-secondary)";
  return (
    <button
      onClick={onClick} aria-label={label} title={label} className="kc-interactive"
      style={{
        width: 52, height: 52, borderRadius: "var(--radius-full)", border: "none",
        background: bg, color, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <StrokeIcon d={d} />
    </button>
  );
}

export function CallOverlay({ webrtc, currentUser, channelName }: Props) {
  const { localStream, remoteStreams, participants, self, callState, quality } = webrtc;
  const [minimized, setMinimized] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  if (callState === "idle") return null;

  const selfName = currentUser?.display_name ?? "You";
  const selfAvatar = currentUser?.avatar_url ?? null;
  const total = participants.length + 1;

  const overlay = (
    <div
      style={{
        position: "fixed", zIndex: 9000,
        ...(minimized
          ? { right: 20, bottom: 20, width: 320, height: 220 }
          : { inset: 0 }),
        background: minimized ? "var(--bg-channel)" : "color-mix(in oklch, var(--bg-base) 88%, black)",
        backdropFilter: minimized ? "none" : "blur(12px)",
        borderRadius: minimized ? "var(--radius-xl)" : 0,
        boxShadow: minimized ? "var(--shadow-lg)" : "none",
        display: "flex", flexDirection: "column",
        padding: minimized ? "var(--space-2)" : "var(--space-5)",
        transition: "all var(--dur-base) var(--ease-out)",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: "var(--space-4)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "4px 12px", borderRadius: "var(--radius-full)",
            background: "color-mix(in oklch, var(--green) 18%, transparent)",
            color: "var(--green)", fontSize: "var(--text-xs)", fontWeight: 700,
          }}>
            <span className="kc-pulse" style={{ width: 8, height: 8, background: "var(--green)" }} />
            LIVE
          </span>
          {!minimized && (
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-lg)" }}>
                {channelName}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
                {total} {total === 1 ? "person" : "people"} on the call
              </div>
            </div>
          )}
        </div>
        <button
          onClick={() => setMinimized((m) => !m)} className="kc-interactive"
          style={{
            border: "none", background: "var(--bg-input)", color: "var(--text-secondary)",
            borderRadius: "var(--radius-md)", padding: "6px 12px", cursor: "pointer",
            fontSize: "var(--text-sm)", fontWeight: 600,
          }}
        >
          {minimized ? "Expand" : "Minimize"}
        </button>
      </div>

      {/* Grid */}
      {!minimized && (
        <div style={{
          flex: 1, display: "grid", gap: "var(--space-3)", minHeight: 0,
          gridTemplateColumns: total <= 1 ? "1fr" : total <= 4 ? "repeat(2, 1fr)" : "repeat(3, 1fr)",
          alignContent: "center",
        }}>
          <VideoTile
            stream={localStream} name={selfName} avatarUrl={selfAvatar}
            muted={self.muted} video={self.video} screen={self.screen} isSelf
          />
          {participants.map((p) => (
            <VideoTile
              key={p.user_id}
              stream={remoteStreams.get(p.user_id) ?? null}
              name={p.user.display_name}
              avatarUrl={p.user.avatar_url}
              muted={p.muted} video={p.video} screen={p.screen} isSelf={false}
              quality={quality[p.user_id]?.level ?? "unknown"}
            />
          ))}
          {total === 1 && (
            <div style={{
              gridColumn: "1 / -1", textAlign: "center", color: "var(--text-muted)",
              fontSize: "var(--text-sm)", marginTop: "var(--space-4)",
            }}>
              You're first to the perch — others can hop in any moment.
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: "var(--space-3)", marginTop: "var(--space-4)", flexShrink: 0,
      }}>
        <ControlBtn d={self.muted ? Icon.micOff : Icon.mic} label={self.muted ? "Unmute" : "Mute"}
          onClick={webrtc.toggleAudio} active={false} danger={self.muted} />
        <ControlBtn d={self.video ? Icon.video : Icon.videoOff} label={self.video ? "Turn camera off" : "Turn camera on"}
          onClick={webrtc.toggleVideo} active={self.video} />
        <ControlBtn d={Icon.screen} label={self.screen ? "Stop sharing" : "Share screen"}
          onClick={() => { if (self.screen) void webrtc.toggleScreenShare(); else setShowShareSheet(true); }}
          active={self.screen} />
        <ControlBtn d={Icon.hangup} label="Leave call" onClick={webrtc.hangUp} danger />
      </div>

      {showShareSheet && (
        <SharePresetSheet
          onClose={() => setShowShareSheet(false)}
          onShare={(presetId, wantAudio) => {
            setShowShareSheet(false);
            void webrtc.toggleScreenShare({ presetId, wantAudio });
          }}
        />
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}
