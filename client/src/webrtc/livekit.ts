import { DEFAULT_PRESET_ID, getPreset, type ScreenSharePresetId } from "./screenShare.ts";

type LiveKitScreenShareCaptureOptions = {
  audio?: boolean | Record<string, unknown>;
  video?: true | { displaySurface?: "window" | "browser" | "monitor" };
  resolution?: { width: number; height: number; frameRate?: number };
  contentHint?: "detail" | "text" | "motion";
  systemAudio?: "include" | "exclude";
};

type LiveKitTrackPublishOptions = {
  screenShareEncoding?: { maxBitrate: number; maxFramerate?: number };
  degradationPreference?: RTCDegradationPreference;
  simulcast?: boolean;
};

function idealNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "ideal" in v) {
    const ideal = (v as { ideal?: unknown }).ideal;
    if (typeof ideal === "number" && Number.isFinite(ideal)) return ideal;
  }
  return undefined;
}

/**
 * LiveKit's `setScreenShareEnabled` does not read our mesh-specific getDisplayMedia
 * helper, so map the same Ohiyo screen-share presets into LiveKit capture/publish
 * options. This keeps SFU screen-share quality aligned with the P2P path.
 */
export function liveKitScreenShareOptions(opts?: { presetId?: ScreenSharePresetId; wantAudio?: boolean }): {
  capture: LiveKitScreenShareCaptureOptions;
  publish: LiveKitTrackPublishOptions;
} {
  const preset = getPreset(opts?.presetId ?? DEFAULT_PRESET_ID);
  const width = idealNumber(preset.video.width) ?? 1920;
  const height = idealNumber(preset.video.height) ?? 1080;
  const frameRate = idealNumber(preset.video.frameRate) ?? 30;
  return {
    capture: {
      video: { displaySurface: "monitor" },
      resolution: { width, height, frameRate },
      contentHint: preset.contentHint,
      audio: opts?.wantAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        : false,
      systemAudio: opts?.wantAudio ? "include" : "exclude",
    },
    publish: {
      screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: frameRate },
      degradationPreference: "maintain-resolution",
      simulcast: true,
    },
  };
}

export type LiveKitMicEnableResult = "published" | "listen-only";

/**
 * Match the mesh engine's reliability behavior: if microphone publication fails
 * (permission denied, no device, browser quirk), join the room listen-only instead of
 * failing the entire call. Muted joins intentionally do not publish a mic until the
 * user unmutes.
 */
export async function enableLiveKitMicrophone(
  participant: { setMicrophoneEnabled: (enabled: boolean) => Promise<unknown> },
  shouldPublish: boolean,
): Promise<LiveKitMicEnableResult> {
  if (!shouldPublish) {
    await participant.setMicrophoneEnabled(false);
    return "listen-only";
  }
  try {
    await participant.setMicrophoneEnabled(true);
    return "published";
  } catch (err) {
    console.warn("[livekit] microphone publish failed; joining listen-only", err);
    try {
      await participant.setMicrophoneEnabled(false);
    } catch {
      // Already failed to publish; best-effort disable only.
    }
    return "listen-only";
  }
}
