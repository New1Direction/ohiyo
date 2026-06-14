// Opus SDP tuning — music-grade stereo audio (beats Discord free-tier voice).
// Line-anchored regex (m flag) so it only ever touches THIS payload type's fmtp.

export const OPUS_TARGET_BITRATE = 256_000; // music-grade stereo

/** Rewrite the Opus fmtp line for music-grade stereo + FEC. */
export function tuneOpusSdp(sdp: string, bitrate = OPUS_TARGET_BITRATE): string {
  const ptMatch = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2/im);
  if (!ptMatch) return sdp;
  const pt = ptMatch[1];

  const opusParams = [
    "stereo=1", // willing to RECEIVE stereo
    "sprop-stereo=1", // WILL SEND stereo (makes music wide)
    "useinbandfec=1",
    "usedtx=0", // DTX off for music
    `maxaveragebitrate=${bitrate}`,
    "maxplaybackrate=48000",
    "cbr=0",
  ].join(";");

  const fmtpRe = new RegExp(`^a=fmtp:${pt} .*$`, "m");
  if (fmtpRe.test(sdp)) return sdp.replace(fmtpRe, `a=fmtp:${pt} ${opusParams}`);
  // No fmtp yet — insert right after the rtpmap line.
  return sdp.replace(
    new RegExp(`^(a=rtpmap:${pt} opus/48000/2\\r?\\n)`, "m"),
    `$1a=fmtp:${pt} ${opusParams}\r\n`,
  );
}

/** Belt-and-suspenders: raise the audio sender's maxBitrate (SDP fmtp is the real lever). */
export async function raiseAudioBitrate(pc: RTCPeerConnection, bps = OPUS_TARGET_BITRATE) {
  const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = bps;
  await sender.setParameters(p).catch(() => {});
}
