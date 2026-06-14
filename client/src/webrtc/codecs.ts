// Prefer modern video codecs (AV1 > VP9 > H264). Validates against RECEIVER
// capabilities (what setCodecPreferences actually checks) with safe fallbacks.

type CodecPref = "av1" | "vp9" | "h264";

// Derive the codec-capability type from the DOM API (name varies across TS lib versions).
type VideoCaps = NonNullable<ReturnType<typeof RTCRtpReceiver.getCapabilities>>;
type CodecCap = VideoCaps["codecs"][number];

function preferredVideoCodecs(order: CodecPref[] = ["av1", "vp9", "h264"]): CodecCap[] | null {
  if (typeof RTCRtpReceiver === "undefined" || !("getCapabilities" in RTCRtpReceiver)) return null;
  const caps = RTCRtpReceiver.getCapabilities("video");
  if (!caps?.codecs?.length) return null;

  const rank = (mime: string): number => {
    const m = mime.toLowerCase();
    if (m.includes("av01") || m.includes("av1")) return order.indexOf("av1");
    if (m.includes("vp9")) return order.indexOf("vp9");
    if (m.includes("h264") || m.includes("avc")) return order.indexOf("h264");
    return -1;
  };

  const media = caps.codecs
    .filter((c) => rank(c.mimeType) !== -1)
    .sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  if (!media.length) return null; // else setCodecPreferences throws InvalidModificationError
  const infra = caps.codecs.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
  return [...media, ...infra];
}

/** Ask the peer connection to negotiate the best available video codec first. */
export function applyVideoCodecPreference(pc: RTCPeerConnection): void {
  const tx = pc
    .getTransceivers()
    .find((t) => t.sender?.track?.kind === "video" || t.receiver?.track?.kind === "video");
  if (!tx || !("setCodecPreferences" in tx)) return;
  const codecs = preferredVideoCodecs();
  if (!codecs) return;
  try {
    tx.setCodecPreferences(codecs);
  } catch (e) {
    // InvalidAccessError / InvalidModificationError → fall back to default ordering.
    console.warn("[webrtc] setCodecPreferences fell back to defaults", e);
  }
}
