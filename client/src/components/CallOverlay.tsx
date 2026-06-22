import { useCallback, useEffect, useRef, useState } from "react";
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
  speaker: "M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13",
  hangup: "M3 11a17 17 0 0 1 18 0l-2.5 3a2 2 0 0 1-2.3.5l-2-1a2 2 0 0 1-1.2-1.8v-1a11 11 0 0 0-4 0v1a2 2 0 0 1-1.2 1.8l-2 1a2 2 0 0 1-2.3-.5L3 11z",
};

const CALL_VOLUMES_KEY = "ohiyo.callVolumes.v1";
const CALL_OUTPUT_KEY = "ohiyo.callOutputDevice.v1";

type SinkMediaElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };
type MediaDevicesWithOutputPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

function clampVolume(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

// One AudioContext for the whole call. Browsers cap concurrent AudioContexts (~6),
// so a per-participant context blows the budget in larger rooms. Analyser nodes are
// cheap and unbounded, so each tile keeps its own analyser off this shared context.
let sharedAudioCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext | null {
  const AudioContextCtor =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") sharedAudioCtx = new AudioContextCtor();
  return sharedAudioCtx;
}

// Reduced-motion gate for the speaking-ring pulse (README promises reduced-motion support).
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function loadCallVolumes(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CALL_VOLUMES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number") out[id] = clampVolume(value);
    }
    return out;
  } catch {
    return {};
  }
}

function loadCallOutputDevice() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(CALL_OUTPUT_KEY) ?? "";
}

function setMediaOutput(el: SinkMediaElement, outputDeviceId: string) {
  if (typeof el.setSinkId !== "function") return;
  void el.setSinkId(outputDeviceId).catch((err) => {
    console.warn("[call] audio output switch failed", err);
  });
}

function useAudioLevel(stream: MediaStream | null, active: boolean) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const audioTracks = stream?.getAudioTracks().filter((track) => track.readyState === "live") ?? [];
    if (!active || audioTracks.length === 0) {
      setLevel(0);
      return;
    }

    // Share one AudioContext across all tiles (see getSharedAudioContext). Each tile
    // still owns its analyser + source, which are cheap and cleaned up below.
    const ctx = getSharedAudioContext();
    if (!ctx) return;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    source.connect(analyser);
    void ctx.resume().catch(() => {});

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      setLevel(Math.sqrt(sum / data.length));
      frame = window.requestAnimationFrame(tick);
    };
    tick();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      // Disconnect this tile's nodes, but leave the SHARED context open for the
      // other tiles still measuring. Closing it would kill everyone's analysers.
      source.disconnect();
      analyser.disconnect();
    };
  }, [stream, active]);

  return { level, speaking: active && level > 0.035 };
}

function RemoteAudioSink({ stream, volume, outputDeviceId }: { stream: MediaStream | null; volume: number; outputDeviceId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    const audioTracks = stream?.getAudioTracks().filter((track) => track.readyState === "live") ?? [];
    audioEl.srcObject = audioTracks.length ? new MediaStream(audioTracks) : null;
    audioEl.volume = clampVolume(volume);
    setMediaOutput(audioEl, outputDeviceId);
    if (audioTracks.length) void audioEl.play().catch((err) => console.warn("[call] remote audio playback blocked", err));
    return () => { audioEl.srcObject = null; };
  }, [stream, volume, outputDeviceId]);

  return <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />;
}

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
  stream, name, avatarUrl, muted, video, screen, isSelf, quality, volume, onVolumeChange,
}: {
  stream: MediaStream | null;
  name: string;
  avatarUrl: string | null;
  muted: boolean;
  video: boolean;
  screen: boolean;
  isSelf: boolean;
  quality?: QualityLevel;
  volume: number;
  outputDeviceId: string;
  onVolumeChange?: (volume: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const showVideo = (video || screen) && !!stream;
  const { level, speaking } = useAudioLevel(stream, !!stream && !muted);
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.srcObject = showVideo ? stream : null;
      videoEl.volume = 0;
    }

    return () => {
      if (videoEl) videoEl.srcObject = null;
    };
  }, [stream, showVideo]);

  const initial = name.charAt(0).toUpperCase();

  return (
    <div
      className={`kc-call-tile kc-card${screen ? " kc-call-tile--screen" : showVideo ? " kc-call-tile--media" : " kc-call-tile--voice"}${speaking ? " kc-call-tile--speaking" : ""}`}
      style={{
        position: "relative",
        overflow: "hidden",
        aspectRatio: showVideo ? "16 / 10" : undefined,
        minHeight: showVideo ? 0 : 220,
        maxHeight: showVideo ? undefined : 320,
        padding: showVideo ? 0 : "var(--space-6)",
        background: showVideo
          ? "var(--bg-input)"
          : "radial-gradient(260px 180px at 50% 44%, color-mix(in oklch, var(--accent) 16%, transparent), transparent 72%), color-mix(in oklch, var(--bg-input) 88%, var(--bg-channel))",
        borderRadius: "var(--radius-lg)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: speaking
          ? `0 0 0 ${reducedMotion ? 4 : Math.max(3, Math.min(10, level * 90))}px color-mix(in oklch, var(--green) 30%, transparent), var(--shadow-md)`
          : "var(--shadow-md)",
      }}
    >
      {showVideo ? (
        <video
          ref={videoRef} autoPlay playsInline muted
          style={{
            width: "100%", height: "100%", objectFit: "contain",
            transform: isSelf && !screen ? "scaleX(-1)" : "none",
            background: "#000",
          }}
        />
      ) : (
        <div style={{
          width: 88, height: 88, borderRadius: "var(--radius-full)",
          background: "var(--accent)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden",
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "2rem",
          boxShadow: speaking ? `0 0 0 ${reducedMotion ? 8 : Math.max(6, Math.min(18, level * 150))}px color-mix(in oklch, var(--green) 24%, transparent)` : "none",
        }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : initial}
        </div>
      )}

      {!isSelf && !screen && onVolumeChange && (
        <div
          style={{
            position: "absolute", right: "var(--space-2)", top: "var(--space-2)",
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 9px", borderRadius: "var(--radius-full)",
            background: "rgba(0,0,0,0.48)", color: "#fff",
            backdropFilter: "blur(8px)",
            boxShadow: "0 10px 28px rgba(0,0,0,.18)",
          }}
        >
          <span style={{ color: volume === 0 ? "var(--danger)" : "#D8DEE6", display: "inline-flex" }}>
            <StrokeIcon d={Icon.speaker} size={14} />
          </span>
          <input
            aria-label={`${name} volume`}
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round(clampVolume(volume) * 100)}
            onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
            style={{ width: 88, accentColor: "var(--accent)" }}
          />
          <span style={{ minWidth: 34, textAlign: "right", color: "#D8DEE6", fontSize: "var(--text-xs)", fontWeight: 700 }}>
            {Math.round(clampVolume(volume) * 100)}%
          </span>
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
        <span style={{ color: muted ? "var(--danger)" : speaking ? "var(--green)" : "#7CF2B0" }}>
          <StrokeIcon d={muted ? Icon.micOff : Icon.mic} size={14} />
        </span>
        {name}{isSelf && " (you)"}{muted ? " · muted" : speaking ? " · speaking" : ""}{screen && " · sharing"}
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

// ── Audio output picker ───────────────────────────────────────────────────────
function AudioOutputSheet({
  devices, selectedId, supported, onPick, onRefresh, onAsk, onClose,
}: {
  devices: MediaDeviceInfo[];
  selectedId: string;
  supported: boolean;
  onPick: (deviceId: string) => void;
  onRefresh: () => void;
  onAsk: () => void;
  onClose: () => void;
}) {
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
          width: "min(520px, 92vw)", background: "var(--bg-channel)",
          borderRadius: "var(--radius-xl)", padding: "var(--space-5)",
          boxShadow: "var(--shadow-lg)", border: "1px solid var(--bg-hover)",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-lg)", marginBottom: "var(--space-1)" }}>
          Call audio
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
          Choose where call audio plays. Per-person volume stays on each call tile.
        </div>

        {supported ? (
          <>
            <label style={{ display: "grid", gap: 6, color: "var(--text-secondary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>
              Output device
              <select
                value={selectedId}
                onChange={(e) => onPick(e.target.value)}
                style={{
                  width: "100%", color: "var(--text-primary)", background: "var(--bg-input)",
                  border: "1px solid var(--bg-hover)", borderRadius: "var(--radius-md)",
                  padding: "10px 12px", outline: "none",
                }}
              >
                <option value="">System default</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId || `output-${i}`} value={d.deviceId}>
                    {d.label || `Speaker ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <p style={{ margin: "var(--space-3) 0 0", color: "var(--text-muted)", fontSize: "var(--text-xs)", lineHeight: 1.45 }}>
              If your headset does not show up, use “Find speakers” and approve the browser prompt.
            </p>
          </>
        ) : (
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
            This browser does not expose speaker switching here yet. You can still use per-person volume,
            and Ohiyo will play through your system default output.
          </p>
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-5)", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={onRefresh} className="kc-interactive"
            style={{ border: "none", background: "var(--bg-input)", color: "var(--text-secondary)",
              borderRadius: "var(--radius-md)", padding: "10px 14px", cursor: "pointer", fontWeight: 600, fontSize: "var(--text-sm)" }}>
            Refresh
          </button>
          {supported && (
            <button onClick={onAsk} className="kc-interactive"
              style={{ border: "none", background: "var(--bg-input)", color: "var(--text-secondary)",
                borderRadius: "var(--radius-md)", padding: "10px 14px", cursor: "pointer", fontWeight: 600, fontSize: "var(--text-sm)" }}>
              Find speakers
            </button>
          )}
          <button onClick={onClose} className="kc-cta"
            style={{ padding: "10px 18px", fontSize: "var(--text-sm)", cursor: "pointer" }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Control button ──────────────────────────────────────────────────────────────
function ControlBtn({
  d, label, onClick, active, danger, compact = false,
}: {
  d: string; label: string; onClick: () => void; active?: boolean; danger?: boolean; compact?: boolean;
}) {
  const bg = danger
    ? "color-mix(in oklch, var(--danger) 86%, #8b3e28)"
    : active
      ? "linear-gradient(145deg, color-mix(in oklch, var(--accent) 82%, white), var(--accent-hover))"
      : "color-mix(in oklch, var(--text-primary) 6%, var(--bg-input))";
  const color = danger || active ? "#fff" : "var(--text-secondary)";
  const short = label.replace("Turn ", "").replace(" off", "").replace(" on", "").replace("Call ", "");
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: compact ? 4 : 6, minWidth: compact ? 48 : 64 }}>
      <button
        onClick={onClick} aria-label={label} title={label} className="kc-interactive"
        style={{
          width: compact ? 46 : 54, height: compact ? 46 : 54, borderRadius: "var(--radius-full)",
          border: `1px solid ${danger || active ? "transparent" : "color-mix(in oklch, var(--text-primary) 9%, transparent)"}`,
          background: bg, color, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: danger
            ? "0 16px 32px -22px var(--danger)"
            : active
              ? "0 16px 32px -22px var(--accent)"
              : "inset 0 1px 0 color-mix(in oklch, var(--text-primary) 5%, transparent)",
        }}
      >
        <StrokeIcon d={d} size={compact ? 18 : 20} />
      </button>
      {!compact && (
        <span style={{ color: danger ? "var(--danger)" : active ? "var(--accent)" : "var(--text-muted)", fontSize: 11, fontWeight: 800, lineHeight: 1 }}>
          {danger ? "Leave" : short}
        </span>
      )}
    </div>
  );
}

function AvatarOrb({ name, avatarUrl, size = 112 }: { name: string; avatarUrl: string | null; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--accent)",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        fontFamily: "var(--font-display)",
        fontWeight: 800,
        fontSize: Math.max(22, size * 0.34),
        boxShadow: "inset 0 0 0 3px color-mix(in oklch, white 18%, transparent)",
      }}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : name.charAt(0).toUpperCase()}
    </div>
  );
}

function LivePill() {
  return (
    <span className="kc-call-live-pill">
      <span className="kc-pulse" style={{ width: 8, height: 8, background: "var(--green)" }} />
      LIVE
    </span>
  );
}

function VoiceParticipantRow({
  stream, name, avatarUrl, muted, isSelf, listenOnly, volume, onVolumeChange,
}: {
  stream: MediaStream | null;
  name: string;
  avatarUrl: string | null;
  muted: boolean;
  isSelf: boolean;
  listenOnly?: boolean;
  volume: number;
  onVolumeChange?: (volume: number) => void;
}) {
  const { level, speaking } = useAudioLevel(stream, !!stream && !muted);
  const reducedMotion = prefersReducedMotion();

  return (
    <div
      className={`kc-call-voice-row${muted ? " kc-call-voice-row--muted" : ""}${isSelf ? " kc-call-voice-row--self" : ""}${speaking ? " kc-call-voice-row--speaking" : ""}`}
      style={{
        boxShadow: speaking
          ? `0 0 0 ${reducedMotion ? 3 : Math.max(2, Math.min(7, level * 90))}px color-mix(in oklch, var(--green) 25%, transparent), var(--shadow-sm)`
          : undefined,
      }}
    >
      <AvatarOrb name={name} avatarUrl={avatarUrl} size={58} />
      <div className="kc-call-voice-row__body">
        <div className="kc-call-voice-row__name">{name}{isSelf ? " (you)" : ""}</div>
        <div className="kc-call-voice-row__status">
          <span className="kc-call-voice-row__mic" aria-hidden="true">
            <StrokeIcon d={muted ? Icon.micOff : Icon.mic} size={13} />
          </span>
          {listenOnly ? "Listening only" : muted ? "Muted" : speaking ? "Speaking" : isSelf ? "Mic is on" : "Listening"}
        </div>
      </div>
      {!isSelf && onVolumeChange && (
        <label className="kc-call-voice-row__volume">
          <span className="kc-call-voice-row__volume-label">Volume</span>
          <input
            aria-label={`${name} volume`}
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round(clampVolume(volume) * 100)}
            onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          />
          <span>{Math.round(clampVolume(volume) * 100)}%</span>
        </label>
      )}
    </div>
  );
}

function ScreenShareParticipantChip({
  stream, name, avatarUrl, muted, screen, isSelf, listenOnly, quality,
}: {
  stream: MediaStream | null;
  name: string;
  avatarUrl: string | null;
  muted: boolean;
  screen: boolean;
  isSelf: boolean;
  listenOnly?: boolean;
  quality?: QualityLevel;
}) {
  const { speaking } = useAudioLevel(stream, !!stream && !muted);
  const status = screen ? "Sharing" : listenOnly ? "Listening" : muted ? "Muted" : speaking ? "Speaking" : isSelf ? "You" : "Here";

  return (
    <div className={`kc-screen-chip${speaking ? " kc-screen-chip--speaking" : ""}${muted ? " kc-screen-chip--muted" : ""}`}>
      <AvatarOrb name={name} avatarUrl={avatarUrl} size={38} />
      <div className="kc-screen-chip__body">
        <div className="kc-screen-chip__name">{name}{isSelf ? " (you)" : ""}</div>
        <div className="kc-screen-chip__status">
          <span aria-hidden="true"><StrokeIcon d={muted ? Icon.micOff : Icon.mic} size={12} /></span>
          {status}
          {quality && <ConnectionBadge level={quality} size={12} />}
        </div>
      </div>
    </div>
  );
}

export function CallOverlay({ webrtc, currentUser, channelName }: Props) {
  const { localStream, remoteStreams, participants, self, callState, quality } = webrtc;
  const [minimized, setMinimized] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [showAudioSheet, setShowAudioSheet] = useState(false);
  const [volumeByUser, setVolumeByUser] = useState<Record<string, number>>(() => loadCallVolumes());
  const [audioOutputId, setAudioOutputId] = useState(() => loadCallOutputDevice());
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const outputSwitchingSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  const refreshAudioOutputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioOutputs(devices.filter((d) => d.kind === "audiooutput"));
    } catch (err) {
      console.warn("[call] enumerate audio outputs failed", err);
    }
  }, []);

  const setParticipantVolume = (userId: string, volume: number) => {
    setVolumeByUser((prev) => {
      const next = { ...prev, [userId]: clampVolume(volume) };
      try { window.localStorage.setItem(CALL_VOLUMES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const pickAudioOutput = useCallback((deviceId: string) => {
    setAudioOutputId(deviceId);
    try { window.localStorage.setItem(CALL_OUTPUT_KEY, deviceId); } catch { /* ignore */ }
  }, []);

  const askForAudioOutput = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices as MediaDevicesWithOutputPicker | undefined;
    try {
      if (mediaDevices?.selectAudioOutput) {
        const device = await mediaDevices.selectAudioOutput();
        pickAudioOutput(device.deviceId);
      }
      await refreshAudioOutputs();
    } catch (err) {
      console.warn("[call] select audio output failed", err);
    }
  }, [pickAudioOutput, refreshAudioOutputs]);

  useEffect(() => {
    if (callState === "idle") return;
    void refreshAudioOutputs();
    if (!navigator.mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refreshAudioOutputs();
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [callState, refreshAudioOutputs]);

  if (callState === "idle") return null;

  const selfName = currentUser?.display_name ?? "You";
  const selfAvatar = currentUser?.avatar_url ?? null;
  const people = [
    {
      id: currentUser?.id ?? "self",
      name: selfName,
      avatarUrl: selfAvatar,
      muted: self.muted,
      video: self.video,
      screen: self.screen,
      listenOnly: self.listenOnly,
      stream: localStream,
      isSelf: true,
      quality: undefined as QualityLevel | undefined,
    },
    ...participants.map((p) => ({
      id: p.user_id,
      name: p.user.display_name,
      avatarUrl: p.user.avatar_url,
      muted: p.muted,
      video: p.video,
      screen: p.screen,
      listenOnly: p.listenOnly,
      stream: remoteStreams.get(p.user_id) ?? null,
      isSelf: false,
      quality: quality[p.user_id]?.level ?? "unknown" as QualityLevel,
    })),
  ];
  const total = people.length;
  const hasMedia = people.some((p) => p.video || p.screen);
  const mode: "solo" | "voice" | "media" = hasMedia ? "media" : total === 1 ? "solo" : "voice";
  const modeLabel = mode === "media" ? "Video room" : mode === "voice" ? "Voice room" : "Solo voice";
  const sortedMediaPeople = [...people].sort((a, b) => Number(b.screen) - Number(a.screen) || Number(b.video) - Number(a.video));
  const hasScreenShare = sortedMediaPeople.some((p) => p.screen);
  const screenPerson = sortedMediaPeople.find((p) => p.screen) ?? sortedMediaPeople[0];
  const supportPeople = screenPerson ? sortedMediaPeople.filter((p) => p.id !== screenPerson.id) : [];

  const controls = (compact = false) => (
    <div className={`${compact ? "kc-call-controls kc-call-controls--compact" : "kc-call-controls"}${hasScreenShare && !compact ? " kc-call-controls--screen" : ""}`}>
      <ControlBtn compact={compact} d={self.muted ? Icon.micOff : Icon.mic} label={self.listenOnly ? "Try microphone" : self.muted ? "Unmute" : "Mute"}
        onClick={() => { void webrtc.toggleAudio(); }} active={false} danger={self.muted && !self.listenOnly} />
      <ControlBtn compact={compact} d={self.video ? Icon.video : Icon.videoOff} label={self.video ? "Turn camera off" : "Turn camera on"}
        onClick={webrtc.toggleVideo} active={self.video} />
      <ControlBtn compact={compact} d={Icon.screen} label={self.screen ? "Stop sharing" : "Share screen"}
        onClick={() => { if (self.screen) void webrtc.toggleScreenShare(); else setShowShareSheet(true); }}
        active={self.screen} />
      {!compact && <ControlBtn d={Icon.speaker} label="Call audio" onClick={() => setShowAudioSheet(true)} active={audioOutputId !== ""} />}
      <ControlBtn compact={compact} d={Icon.hangup} label="Leave call" onClick={webrtc.hangUp} danger />
    </div>
  );

  const renderVoiceRow = (person: (typeof people)[number]) => (
    <VoiceParticipantRow
      key={person.id}
      stream={person.stream}
      name={person.name}
      avatarUrl={person.avatarUrl}
      muted={person.muted}
      isSelf={person.isSelf}
      listenOnly={person.listenOnly}
      volume={person.isSelf ? 1 : volumeByUser[person.id] ?? 1}
      onVolumeChange={person.isSelf ? undefined : (volume) => setParticipantVolume(person.id, volume)}
    />
  );

  const renderPersonTile = (person: (typeof people)[number]) => (
    <VideoTile
      key={person.id}
      stream={person.stream}
      name={person.name}
      avatarUrl={person.avatarUrl}
      muted={person.muted}
      video={person.video}
      screen={person.screen}
      isSelf={person.isSelf}
      quality={person.quality}
      volume={person.isSelf ? 1 : volumeByUser[person.id] ?? 1}
      outputDeviceId={audioOutputId}
      onVolumeChange={person.isSelf ? undefined : (volume) => setParticipantVolume(person.id, volume)}
    />
  );

  const overlay = (
    <div
      className={`kc-call-overlay${hasScreenShare ? " kc-call-overlay--screen" : ""}`}
      style={{
        position: "fixed", zIndex: 9000,
        ...(minimized
          ? { right: 18, bottom: 18, width: "min(390px, calc(100vw - 32px))" }
          : { inset: 0 }),
        background: minimized
          ? "linear-gradient(145deg, color-mix(in oklch, var(--bg-channel) 94%, var(--accent)), var(--bg-base))"
          : "radial-gradient(920px 540px at 50% 38%, color-mix(in oklch, var(--accent) 13%, transparent), transparent 68%), linear-gradient(180deg, color-mix(in oklch, var(--bg-base) 94%, black), var(--bg-base))",
        backdropFilter: minimized ? "blur(16px)" : "blur(12px)",
        borderRadius: minimized ? 28 : 0,
        border: minimized ? "1px solid color-mix(in oklch, var(--text-primary) 10%, transparent)" : "none",
        boxShadow: minimized ? "0 28px 80px -48px #000" : "none",
        display: "flex", flexDirection: "column",
        padding: minimized ? 14 : "clamp(14px, 2.6vw, 28px)",
        transition: "all var(--dur-base) var(--ease-out)",
      }}
    >
      {people.filter((person) => !person.isSelf).map((person) => (
        <RemoteAudioSink
          key={`audio-${person.id}`}
          stream={person.stream}
          volume={volumeByUser[person.id] ?? 1}
          outputDeviceId={audioOutputId}
        />
      ))}
      {minimized ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AvatarOrb name={selfName} avatarUrl={selfAvatar} size={46} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <LivePill />
                <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 800 }}>{modeLabel}</span>
              </div>
              <div style={{ marginTop: 5, fontFamily: "var(--font-display)", fontWeight: 800, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {channelName}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{total} {total === 1 ? "person" : "people"}</div>
            </div>
            <button
              onClick={() => setMinimized(false)} className="kc-interactive"
              style={{ border: "none", background: "var(--bg-input)", color: "var(--text-secondary)", borderRadius: 14, padding: "8px 11px", cursor: "pointer", fontWeight: 800 }}
            >
              Open
            </button>
          </div>
          {controls(true)}
        </div>
      ) : (
        <>
          <div className="kc-call-header" style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 14, marginBottom: "clamp(12px, 2vh, 22px)", flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minWidth: 0 }}>
              <LivePill />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-xl)", letterSpacing: "-0.04em", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {channelName}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", fontWeight: 650 }}>
                  {total} {total === 1 ? "person" : "people"} · {modeLabel}
                </div>
              </div>
            </div>
            <button
              onClick={() => setMinimized(true)} className="kc-interactive"
              style={{
                border: "none", background: "var(--bg-input)", color: "var(--text-secondary)",
                borderRadius: 16, padding: "9px 14px", cursor: "pointer",
                fontSize: "var(--text-sm)", fontWeight: 800,
              }}
            >
              Minimize
            </button>
          </div>

          {mode === "solo" && (
            <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: "clamp(18px, 5vh, 54px)", overflow: "hidden" }}>
              <div
                className="kc-fade-up"
                style={{
                  width: "min(480px, calc(100vw - 48px))",
                  display: "grid",
                  justifyItems: "center",
                  gap: 15,
                  padding: "38px 30px",
                  borderRadius: 36,
                  background: "radial-gradient(360px 220px at 50% 24%, color-mix(in oklch, var(--accent) 18%, transparent), transparent 72%), color-mix(in oklch, var(--bg-channel) 92%, var(--bg-base))",
                  border: "1px solid color-mix(in oklch, var(--text-primary) 9%, transparent)",
                  boxShadow: "0 30px 90px -62px #000, inset 0 1px 0 color-mix(in oklch, white 5%, transparent)",
                  backdropFilter: "blur(18px)",
                }}
              >
                <div style={{ padding: 18, borderRadius: "50%", background: "radial-gradient(circle, color-mix(in oklch, var(--accent) 28%, transparent), transparent 68%)", boxShadow: "0 0 0 12px color-mix(in oklch, var(--accent) 7%, transparent), 0 0 0 25px color-mix(in oklch, var(--accent) 4%, transparent)" }}>
                  <AvatarOrb name={selfName} avatarUrl={selfAvatar} size={118} />
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 850, letterSpacing: "-0.05em", color: "var(--text-primary)" }}>{selfName}</div>
                  <div style={{ marginTop: 6, color: "var(--text-secondary)", fontSize: 14, fontWeight: 700 }}>You’re live in {channelName}</div>
                  <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.45 }}>Waiting for someone else to hop in. This room is ready when they are.</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: self.muted ? "var(--danger)" : "var(--green)", fontSize: 12, fontWeight: 850 }}>
                  <StrokeIcon d={self.muted ? Icon.micOff : Icon.mic} size={14} />
                  {self.muted ? "Muted" : "Mic is on"}
                </div>
              </div>
            </div>
          )}

          {mode === "voice" && (
            <div className="kc-voice-stage">
              <div className="kc-voice-stack-card kc-fade-up">
                <div className="kc-voice-stack-card__head">
                  <div>
                    <div className="kc-call-kicker">Voice room</div>
                    <div className="kc-voice-stack-card__title">People in {channelName}</div>
                  </div>
                  <div className="kc-voice-stack-card__count">{total} here</div>
                </div>
                <div className="kc-voice-stack">
                  {people.map(renderVoiceRow)}
                </div>
              </div>
            </div>
          )}

          {mode === "media" && hasScreenShare && screenPerson && (
            <div className="kc-screen-share-stage">
              <div className="kc-screen-share-stage__screen">
                {renderPersonTile(screenPerson)}
              </div>
              {supportPeople.length > 0 && (
                <div className="kc-screen-share-rail" aria-label="People in this call">
                  {supportPeople.map((person) => (
                    <ScreenShareParticipantChip
                      key={person.id}
                      stream={person.stream}
                      name={person.name}
                      avatarUrl={person.avatarUrl}
                      muted={person.muted}
                      screen={person.screen}
                      isSelf={person.isSelf}
                      listenOnly={person.listenOnly}
                      quality={person.quality}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === "media" && !hasScreenShare && (
            <div className={`kc-media-stage kc-media-stage--${Math.min(total, 6)}`}>
              {sortedMediaPeople.map(renderPersonTile)}
            </div>
          )}

          <div style={{ marginTop: "clamp(12px, 2vh, 22px)" }}>
            {controls(false)}
          </div>
        </>
      )}

      {showShareSheet && (
        <SharePresetSheet
          onClose={() => setShowShareSheet(false)}
          onShare={(presetId, wantAudio) => {
            setShowShareSheet(false);
            void webrtc.toggleScreenShare({ presetId, wantAudio });
          }}
        />
      )}

      {showAudioSheet && (
        <AudioOutputSheet
          devices={audioOutputs}
          selectedId={audioOutputId}
          supported={outputSwitchingSupported}
          onPick={pickAudioOutput}
          onRefresh={() => void refreshAudioOutputs()}
          onAsk={() => void askForAudioOutput()}
          onClose={() => setShowAudioSheet(false)}
        />
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}
