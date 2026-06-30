import test from "node:test";
import assert from "node:assert/strict";
import { enableLiveKitMicrophone, liveKitScreenShareOptions } from "../src/webrtc/livekit.ts";

test("LiveKit screen share uses Ohiyo sharp preset by default", () => {
  const { capture, publish } = liveKitScreenShareOptions();
  assert.deepEqual(capture.video, { displaySurface: "monitor" });
  assert.deepEqual(capture.resolution, { width: 3840, height: 2160, frameRate: 30 });
  assert.equal(capture.contentHint, "text");
  assert.equal(capture.audio, false);
  assert.equal(capture.systemAudio, "exclude");
  assert.equal(publish.screenShareEncoding?.maxBitrate, 24_000_000);
  assert.equal(publish.screenShareEncoding?.maxFramerate, 30);
  assert.equal(publish.degradationPreference, "maintain-resolution");
});

test("LiveKit screen share can request smooth system-audio capture", () => {
  const { capture, publish } = liveKitScreenShareOptions({ presetId: "smooth", wantAudio: true });
  assert.deepEqual(capture.resolution, { width: 1920, height: 1080, frameRate: 60 });
  assert.equal(capture.contentHint, "motion");
  assert.equal(capture.systemAudio, "include");
  assert.deepEqual(capture.audio, {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  assert.equal(publish.screenShareEncoding?.maxBitrate, 12_000_000);
  assert.equal(publish.screenShareEncoding?.maxFramerate, 60);
});

test("LiveKit mic helper falls back to listen-only when publish fails", async () => {
  const calls: boolean[] = [];
  const result = await enableLiveKitMicrophone({
    async setMicrophoneEnabled(enabled: boolean) {
      calls.push(enabled);
      if (enabled) throw new Error("permission denied");
    },
  }, true);
  assert.equal(result, "listen-only");
  assert.deepEqual(calls, [true, false]);
});

test("LiveKit muted join does not force mic capture", async () => {
  const calls: boolean[] = [];
  const result = await enableLiveKitMicrophone({
    async setMicrophoneEnabled(enabled: boolean) {
      calls.push(enabled);
    },
  }, false);
  assert.equal(result, "listen-only");
  assert.deepEqual(calls, [false]);
});
