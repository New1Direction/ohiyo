// Opus SDP tuning — music-grade stereo audio (beats Discord free-tier voice).
// Line-anchored regex (m flag) so it only ever touches THIS payload type's fmtp.

export const OPUS_TARGET_BITRATE = 256_000; // music-grade stereo

/** Parse a `key=value;key=value` fmtp param string into an ordered map. */
function parseFmtpParams(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) params.set(trimmed, "");
    else params.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return params;
}

/** Rewrite the Opus fmtp line for music-grade stereo + FEC. */
export function tuneOpusSdp(sdp: string, bitrate = OPUS_TARGET_BITRATE): string {
  const ptMatch = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2/im);
  if (!ptMatch) return sdp;
  const pt = ptMatch[1];

  // Our desired params, in order. Merged on top of whatever the browser already emitted
  // (minptime, useinbandfec, etc.) so we never drop the browser's defaults.
  const desired: [string, string][] = [
    ["stereo", "1"], // willing to RECEIVE stereo
    ["sprop-stereo", "1"], // WILL SEND stereo (makes music wide)
    ["useinbandfec", "1"],
    ["usedtx", "0"], // DTX off for music
    ["maxaveragebitrate", String(bitrate)],
    ["maxplaybackrate", "48000"],
    ["cbr", "0"],
  ];

  // Capture the existing fmtp line AND its line terminator so we can reuse it verbatim
  // (avoids forcing \r\n onto an \n-only SDP).
  const fmtpRe = new RegExp(`^a=fmtp:${pt} (.*?)(\\r?\\n)`, "m");
  const existing = sdp.match(fmtpRe);
  if (existing) {
    const merged = parseFmtpParams(existing[1]);
    for (const [k, v] of desired) merged.set(k, v); // override/add ours, keep the rest
    const paramStr = [...merged].map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
    return sdp.replace(fmtpRe, `a=fmtp:${pt} ${paramStr}${existing[2]}`);
  }

  // No fmtp yet — insert right after the rtpmap line, reusing that line's terminator.
  const opusParams = desired.map(([k, v]) => `${k}=${v}`).join(";");
  return sdp.replace(
    new RegExp(`^(a=rtpmap:${pt} opus/48000/2)(\\r?\\n)`, "m"),
    `$1$2a=fmtp:${pt} ${opusParams}$2`,
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
