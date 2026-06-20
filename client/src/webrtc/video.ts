// Video encoding parameters — the reliable lever for video quality/bitrate.

export type VideoProfile = {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
};

export const CAMERA_720P: VideoProfile = { maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 };
export const CAMERA_1080P: VideoProfile = { maxBitrate: 4_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 };

/** RTCConfiguration tuned for low-latency, high-quality mesh calls. */
export function rtcConfig(iceServers: RTCIceServer[]): RTCConfiguration {
  return {
    iceServers,
    bundlePolicy: "max-bundle", // one transport for all m-lines → fewer ports, faster setup
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 4, // pre-gather → lower offer latency
    iceTransportPolicy: "all", // keep P2P available; TURN is fallback only
  };
}

/** MESH: total upload = per-peer × (N-1). Clamp bitrate by peer count to protect home uplinks. */
export async function applyVideoProfile(
  pc: RTCPeerConnection,
  profile: VideoProfile,
  preference: RTCDegradationPreference,
  peerCount = 1,
): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  const enc = params.encodings[0];
  const divisor = Math.max(1, peerCount - 1);
  enc.maxBitrate = Math.max(500_000, Math.floor(profile.maxBitrate / divisor)); // floor 500kbps
  enc.maxFramerate = profile.maxFramerate;
  enc.scaleResolutionDownBy = profile.scaleResolutionDownBy;
  // degradationPreference lives on params in current specs; re-assert (resets on fresh getParameters).
  (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference })
    .degradationPreference = preference;
  await sender.setParameters(params).catch((e) => console.warn("[webrtc] setParameters", e));
}

/** Music-grade capture: default `audio:true` enables AGC/NS/EC which destroy music. */
export const MUSIC_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  // Prefer music-grade capture, but do not reject ordinary mono laptop/headset mics.
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 },
};
