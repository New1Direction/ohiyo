// Can this browser or desktop shell make a call at all? Pure, for unit tests.
// A missing microphone is not a blocker: Ohiyo joins listen-only (see useWebRTC).

export interface CallEnvironment {
  RTCPeerConnection?: unknown;
  mediaDevices?: { getUserMedia?: unknown } | null;
}

export const VOICE_UNAVAILABLE = "Voice isn't available in this app yet. Open Ohiyo in your browser to join.";

/** True when peer connections exist, which is the one thing a call cannot do without. */
export function canCall(env: CallEnvironment): boolean {
  return typeof env.RTCPeerConnection === "function";
}

/** The real environment, read at call time. */
export function callEnvironment(): CallEnvironment {
  return {
    RTCPeerConnection: typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection,
    mediaDevices: typeof navigator === "undefined" ? null : navigator.mediaDevices,
  };
}
