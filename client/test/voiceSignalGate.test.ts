// C-M8: a call signal (offer, answer, ICE candidate) is acted on only when this user is in
// a call on that channel and the sender is a current participant of that call. The real
// mesh hook runs under react-dom/server with stub WebRTC objects; "acted on" means a peer
// connection was opened or given a remote description.
//
// No race with a legitimate first offer: the server handles one connection's events in
// order and delivers VoiceState and VoiceSignal through the same per-connection queue, so
// a participant sees the joiner's VoiceState(joined) before the joiner's offer, and the
// joiner gets the roster before sending offers. The hook records both as they arrive.
//   node --experimental-strip-types --test test/voiceSignalGate.test.ts

import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Hook = typeof import("../src/hooks/useWebRTC.ts");
type Api = ReturnType<Hook["useWebRTC"]>;
type Mod = { runWebRTC: (cb: Parameters<Hook["useWebRTC"]>[0]) => Api };

class FakePeer {
  static opened: FakePeer[] = [];
  signalingState = "stable";
  connectionState = "new";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  constructor() {
    FakePeer.opened.push(this);
  }
  addTrack() {
    return {};
  }
  addTransceiver() {
    return {};
  }
  getSenders() {
    return [];
  }
  getReceivers() {
    return [];
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "" };
  }
  async setLocalDescription(d: unknown) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  close() {}
}

class FakeStream {
  tracks: { kind: string; enabled: boolean; stop: () => void }[];
  constructor(tracks: FakeStream["tracks"] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeStream["tracks"][number]) {
    this.tracks.push(t);
  }
}

let bundle: Bundle<Mod>;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.RTCPeerConnection = FakePeer;
  g.MediaStream = FakeStream;
  // joinVoice gives every call a blank video track drawn from a canvas.
  g.document = {
    createElement: () => ({
      getContext: () => null,
      captureStream: () => new FakeStream([{ kind: "video", enabled: true, stop() {} }]),
    }),
  };
  bundle = await bundleEntry<Mod>(join(fixtures, "runWebRTC.tsx"));
});

after(async () => {
  await bundle?.cleanup();
});

beforeEach(() => {
  FakePeer.opened = [];
  mock.timers.enable({ apis: ["setTimeout"] }); // joinVoice's 5s ICE-fetch timeout
});

afterEach(() => mock.timers.reset());

function call(): Api {
  return bundle.mod.runWebRTC({
    currentUserId: "me",
    getIceServers: async () => [],
    sendJoin() {},
    sendLeave() {},
    sendMeta() {},
    sendSignal() {},
  });
}

const peer = (user_id: string) => ({
  user_id,
  user: { id: user_id, username: user_id, display_name: null, avatar_url: null },
  muted: false,
  video: false,
  screen: false,
  listenOnly: false,
});
const joined = (channel_id: string, user_id: string, isJoined = true) => ({ channel_id, joined: isJoined, ...peer(user_id) });
const offer = (from: string, channel_id: string) => ({
  from,
  to: "me",
  channel_id,
  kind: "offer",
  payload: JSON.stringify({ type: "offer", sdp: "" }),
});

test("an offer is ignored when this user is in no call", async () => {
  const api = call();
  await api.onPeerSignal(offer("p1", "c1"));
  assert.equal(FakePeer.opened.length, 0);
});

test("in a call, an offer from a participant is answered and anyone else's is ignored", async () => {
  const api = call();
  await api.joinVoice("c1");
  api.onVoiceState(joined("c1", "p1"));
  await api.onPeerSignal(offer("outsider", "c1"));
  await api.onPeerSignal(offer("p1", "c2"));
  assert.equal(FakePeer.opened.length, 0);
  await api.onPeerSignal(offer("p1", "c1"));
  assert.equal(FakePeer.opened.length, 1);
});

test("an answer from a peer in the roster is applied", async () => {
  const api = call();
  await api.joinVoice("c1");
  api.onRoster("c1", [peer("p2")]);
  assert.equal(FakePeer.opened.length, 1); // we offer to everyone already in the call
  const answer = { type: "answer", sdp: "" };
  await api.onPeerSignal({ from: "p2", to: "me", channel_id: "c1", kind: "answer", payload: JSON.stringify(answer) });
  assert.deepEqual(FakePeer.opened[0].remoteDescription, answer);
});

test("signals from a participant who left, or after hanging up, are ignored", async () => {
  const api = call();
  await api.joinVoice("c1");
  api.onVoiceState(joined("c1", "p1"));
  api.onVoiceState(joined("c1", "p1", false));
  await api.onPeerSignal(offer("p1", "c1"));
  api.onVoiceState(joined("c1", "p3"));
  api.hangUp();
  await api.onPeerSignal(offer("p3", "c1"));
  assert.equal(FakePeer.opened.length, 0);
});
