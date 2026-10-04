// The YouTube player in a watch party is an <iframe> driven by postMessage. The old code
// loaded https://www.youtube.com/iframe_api into the page, which the web build's CSP
// (`script-src 'self'`) blocks, so YouTube parties showed an empty box; loading it would
// also run a third party's script inside the app. These are the messages both ways.
//   node --experimental-strip-types --test test/youtubeEmbed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  YOUTUBE_EMBED_ORIGIN,
  YT_PAUSED,
  YT_PLAYING,
  parseYouTubeMessage,
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
