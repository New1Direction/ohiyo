// Screen-share quality presets + display capture (incl. optional system audio).
// Screen share is a flagship Ohiyo feature: default to crisp/native detail, while
// still offering 1080p60 for motion. Free 1080p60 / 4K with system audio — all
// gated behind Nitro on Discord.

export type ScreenSharePresetId = "smooth" | "balanced" | "sharp";

export interface ScreenSharePreset {
  id: ScreenSharePresetId;
  label: string;
  blurb: string;
  video: MediaTrackConstraints;
  contentHint: "motion" | "detail" | "text";
  maxBitrate: number; // encoding ceiling; congestion control rides below
}

const MBPS = 1_000_000;

export const SCREEN_SHARE_PRESETS: readonly ScreenSharePreset[] = [
  {
    id: "smooth",
    label: "Smooth",
    blurb: "1080p · 60 fps — gameplay & motion",
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    },
    contentHint: "motion",
    maxBitrate: 12 * MBPS,
  },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "1080p · 30 fps — the everyday default",
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    contentHint: "detail",
    maxBitrate: 6 * MBPS,
  },
  {
    id: "sharp",
    label: "Sharp",
    blurb: "4K / native · 30 fps — text & fine detail",
    video: {
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30, max: 30 },
    },
    contentHint: "text",
    maxBitrate: 24 * MBPS,
  },
] as const;

export const DEFAULT_PRESET_ID: ScreenSharePresetId = "sharp";

export function getPreset(id: ScreenSharePresetId): ScreenSharePreset {
  return SCREEN_SHARE_PRESETS.find((x) => x.id === id) ?? SCREEN_SHARE_PRESETS[1];
}

export interface DisplayCaptureResult {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
}

/** Capture the display with a preset's constraints + optional system/tab audio. */
export async function captureDisplay(
  preset: ScreenSharePreset,
  wantAudio: boolean,
): Promise<DisplayCaptureResult> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      ...preset.video,
      // Advisory where supported; ignored elsewhere. We prefer full display/native
      // capture because cropped/low-detail sharing is worse than Discord, not better.
      displaySurface: "monitor",
    } as MediaTrackConstraints,
    audio: wantAudio
      ? ({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // systemAudio is Chromium-only and advisory.
          systemAudio: "include",
        } as MediaTrackConstraints)
      : false,
  });
  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.contentHint = preset.contentHint; // before replaceTrack
  const audioTrack = stream.getAudioTracks()[0] ?? null;
  if (audioTrack) audioTrack.contentHint = "music";
  return { stream, videoTrack, audioTrack };
}

/** Apply a screen-share bitrate ceiling to a video sender. */
export async function applySenderBitrate(sender: RTCRtpSender, maxBitrate: number): Promise<void> {
  const p = sender.getParameters() as RTCRtpSendParameters & {
    degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
    encodings?: Array<RTCRtpEncodingParameters & { priority?: "very-low" | "low" | "medium" | "high"; networkPriority?: "very-low" | "low" | "medium" | "high" }>;
  };
  if (!p.encodings?.length) p.encodings = [{}];
  p.degradationPreference = "maintain-resolution";
  p.encodings[0].maxBitrate = maxBitrate;
  p.encodings[0].scaleResolutionDownBy = 1;
  p.encodings[0].priority = "high";
  p.encodings[0].networkPriority = "high";
  await sender.setParameters(p).catch(() => {});
}

/** True when the browser can capture display audio (Chromium-family). */
export function supportsDisplayAudio(): boolean {
  const ua = navigator.userAgent;
  return /Chrome|Edg|Chromium/.test(ua) && !/Firefox/.test(ua);
}
