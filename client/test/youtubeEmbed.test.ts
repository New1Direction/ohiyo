// The YouTube player in a watch party is an <iframe> driven by postMessage. The old code
// loaded https://www.youtube.com/iframe_api into the page, which the web build's CSP
// (`script-src 'self'`) blocks, so YouTube parties showed an empty box; loading it would
// also run a third party's script inside the app. These are the messages both ways.
//   node --experimental-strip-types --test test/youtubeEmbed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  YOUTUBE_EMBED_ORIGIN,
  YT_BUFFERING,
  YT_ENDED,
  YT_PAUSED,
  YT_PLAYING,
  advanceClock,
  countsAsPlaying,
  parseYouTubeMessage,
  playerTimeAt,
  youtubeControlFor,
  youtubeCommand,
  youtubeEmbedUrl,
  youtubeListening,
} from "../src/lib/youtubeEmbed.ts";

test("the embed is the no-cookie player with the message API on, told who its parent is", () => {
  const url = new URL(youtubeEmbedUrl("aqz-KE-bpKQ", "https://app.ohiyo.gg"));
  assert.equal(url.origin, "https://www.youtube-nocookie.com");
  assert.equal(url.origin, YOUTUBE_EMBED_ORIGIN);
  assert.equal(url.pathname, "/embed/aqz-KE-bpKQ");
  assert.equal(url.searchParams.get("enablejsapi"), "1");
  assert.equal(url.searchParams.get("origin"), "https://app.ohiyo.gg");
  assert.equal(url.searchParams.get("playsinline"), "1");
});

test("a video id can't break out of the embed path", () => {
  const url = new URL(youtubeEmbedUrl("../x?y=1#z", "https://app.ohiyo.gg"));
  assert.equal(url.origin, YOUTUBE_EMBED_ORIGIN);
  assert.ok(url.pathname.startsWith("/embed/"));
  assert.equal(url.searchParams.get("y"), null);
});

test("commands are the player's JSON envelope", () => {
  assert.deepEqual(JSON.parse(youtubeListening()), { event: "listening", id: 1, channel: "widget" });
  assert.deepEqual(JSON.parse(youtubeCommand("seekTo", [42.5, true])), {
    event: "command",
    func: "seekTo",
    args: [42.5, true],
    id: 1,
    channel: "widget",
  });
  assert.deepEqual(JSON.parse(youtubeCommand("playVideo")).args, []);
});

test("messages from anywhere but the player are ignored", () => {
  const data = JSON.stringify({ event: "onReady" });
  assert.equal(parseYouTubeMessage("https://evil.example", data), null);
  assert.equal(parseYouTubeMessage("https://www.youtube-nocookie.com.evil.example", data), null);
  assert.deepEqual(parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, data), { ready: true });
});

test("state and time are read from the player's info messages", () => {
  const info = (i: unknown, event = "infoDelivery") =>
    parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, JSON.stringify({ event, info: i }));
  assert.deepEqual(info({ playerState: YT_PLAYING, currentTime: 12.5, duration: 600 }, "initialDelivery"), {
    state: YT_PLAYING,
    time: 12.5,
  });
  assert.deepEqual(info({ currentTime: 13.1, videoBytesLoaded: 0.4 }), { time: 13.1 });
  assert.deepEqual(info({ videoBytesLoaded: 0.4 }), {});
  assert.deepEqual(info(YT_PAUSED, "onStateChange"), { state: YT_PAUSED });
});

test("an object payload works like a JSON string, and junk is ignored", () => {
  assert.deepEqual(parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, { event: "onReady" }), { ready: true });
  assert.equal(parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, "not json"), null);
  assert.equal(parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, 42), null);
  assert.equal(parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, JSON.stringify({ event: "somethingElse" })), null);
  assert.deepEqual(
    parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, JSON.stringify({ event: "infoDelivery", info: { currentTime: "x" } })),
    {}
  );
});

// The player reports its position only while it changes, so the app keeps a small clock:
// the last reported time, when it was reported, and the player state.
const at = (seconds: number) => seconds * 1000;
const clock = (time: number, atSeconds: number, state: number | null) => ({ time, at: at(atSeconds), state });

test("while playing, the position runs on from the last report", () => {
  assert.equal(playerTimeAt(clock(10, 100, YT_PLAYING), at(102.5)), 12.5);
});

test("while paused, buffering or ended, the position stays where it was", () => {
  for (const state of [YT_PAUSED, YT_BUFFERING, YT_ENDED, null]) {
    assert.equal(playerTimeAt(clock(10, 100, state), at(160)), 10);
  }
});

test("resuming after a 30 s pause does not add the 30 s to the position", () => {
  // Paused at 10 s; nothing is reported while paused; 30 s later the player says PLAYING.
  const paused = clock(10, 100, YT_PAUSED);
  const { clock: resumed, stateChanged, jumped } = advanceClock(paused, { state: YT_PLAYING }, at(130));
  assert.equal(stateChanged, true);
  assert.equal(jumped, false);
  assert.equal(playerTimeAt(resumed, at(130)), 10);
  assert.equal(playerTimeAt(resumed, at(131)), 11);
});

test("a stall is not counted as playback either", () => {
  let c = clock(10, 100, YT_PLAYING);
  c = advanceClock(c, { state: YT_BUFFERING }, at(101)).clock; // reached 11, then stalled
  assert.equal(playerTimeAt(c, at(109)), 11);
  c = advanceClock(c, { state: YT_PLAYING }, at(109)).clock;
  assert.equal(playerTimeAt(c, at(110)), 12);
});

test("ordinary time reports are not jumps; a seek is, playing or paused", () => {
  const playing = clock(10, 100, YT_PLAYING);
  assert.equal(advanceClock(playing, { time: 10.5 }, at(100.5)).jumped, false);
  assert.equal(advanceClock(playing, { time: 10.9 }, at(100.5)).jumped, false);
  assert.equal(advanceClock(playing, { time: 120 }, at(100.5)).jumped, true);
  assert.equal(advanceClock(clock(10, 100, YT_PAUSED), { time: 40 }, at(105)).jumped, true);
  assert.equal(advanceClock(clock(10, 100, YT_PAUSED), { time: 10 }, at(160)).jumped, false);
});

test("a report with the same state is not a state change", () => {
  const r = advanceClock(clock(10, 100, YT_PLAYING), { state: YT_PLAYING, time: 10.4 }, at(100.4));
  assert.equal(r.stateChanged, false);
  assert.equal(r.clock.time, 10.4);
});

test("what a player state means: the host drives, a guest is put back, the end is a pause", () => {
  assert.equal(youtubeControlFor(YT_PLAYING, true), "play");
  assert.equal(youtubeControlFor(YT_PAUSED, true), "pause");
  assert.equal(youtubeControlFor(YT_ENDED, true), "pause");
  assert.equal(youtubeControlFor(YT_PLAYING, false), "resync");
  assert.equal(youtubeControlFor(YT_PAUSED, false), "resync");
  assert.equal(youtubeControlFor(YT_ENDED, false), null);
  assert.equal(youtubeControlFor(YT_BUFFERING, true), null);
  assert.equal(youtubeControlFor(YT_BUFFERING, false), null);
});

test("a player that is playing, buffering or at the end was not stopped by autoplay rules", () => {
  for (const state of [YT_PLAYING, YT_BUFFERING, YT_ENDED]) assert.equal(countsAsPlaying(state), true);
  for (const state of [YT_PAUSED, 5, -1, null]) assert.equal(countsAsPlaying(state), false);
});


test("volume reports are bounded numbers, separate from party playback", () => {
  const info = (volume: unknown) => parseYouTubeMessage(YOUTUBE_EMBED_ORIGIN, { event: "infoDelivery", info: { volume } });
  assert.deepEqual(info(55), { volume: 55 });
  for (const invalid of [-1, 101, NaN, Infinity, "50", null]) assert.deepEqual(info(invalid), {});
  assert.deepEqual(JSON.parse(youtubeCommand("setVolume", [60])).args, [60]);
});
