// Some desktop shells cannot make calls at all (the Linux app's web engine is the likely
// one). The app says so before trying, instead of failing after the click.
//   node --experimental-strip-types --test test/voiceSupport.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { VOICE_UNAVAILABLE, canCall, refusesCall } from "../src/lib/voiceSupport.ts";

class FakePeerConnection {}

test("a shell with peer connections can call", () => {
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: { getUserMedia() {} } }), true);
});

test("no microphone access is still a call: Ohiyo joins listen-only", () => {
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: undefined }), true);
  assert.equal(canCall({ RTCPeerConnection: FakePeerConnection, mediaDevices: null }), true);
});

test("a shell without peer connections cannot call", () => {
  assert.equal(canCall({ RTCPeerConnection: undefined, mediaDevices: { getUserMedia() {} } }), false);
  assert.equal(canCall({}), false);
});

test("the message tells the person where a call does work", () => {
  assert.equal(VOICE_UNAVAILABLE, "Voice isn't available in this app yet. Open Ohiyo in your browser to join.");
});

test("only the desktop app refuses up front; a browser tries the call as it always has", () => {
  assert.equal(refusesCall(true, {}), true);
  assert.equal(refusesCall(true, { RTCPeerConnection: FakePeerConnection }), false);
  // "Open Ohiyo in your browser" is no help to someone already in a browser.
  assert.equal(refusesCall(false, {}), false);
});
