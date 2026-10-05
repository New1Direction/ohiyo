// Links that can play in the chat: YouTube videos and posts on X. Which links count, the
// frame each one loads, and how tall its row is (the chat list is virtualized, so heights
// are worked out before anything renders).
//   node --experimental-strip-types --test test/linkEmbeds.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMBED_CHIP_PX,
  NO_OPEN_EMBEDS,
  X_FRAME_ORIGIN,
  X_FRAME_START_PX,
  embedKey,
  embedRowPx,
  enteringChat,
  linkEmbedFor,
  openHeightsIn,
  withEmbedHeight,
  xFrameHeight,
  xPostFrameUrl,
  youtubePlayerUrl,
  youtubeThumbnailUrl,
} from "../src/lib/linkEmbeds.ts";

const ID = "dQw4w9WgXcQ";

test("the usual YouTube links are recognised", () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&index=2`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abcdef`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
  ]) {
    assert.deepEqual(linkEmbedFor(url), { kind: "youtube", id: ID, start: 0 }, url);
  }
});

test("a YouTube link keeps the moment it points at", () => {
  const start = (url: string) => {
    const embed = linkEmbedFor(url);
    return embed?.kind === "youtube" ? embed.start : null;
  };
  assert.equal(start(`https://youtu.be/${ID}?t=90`), 90);
  assert.equal(start(`https://youtu.be/${ID}?t=90s`), 90);
  assert.equal(start(`https://www.youtube.com/watch?v=${ID}&t=1m30s`), 90);
  assert.equal(start(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`), 3723);
  assert.equal(start(`https://www.youtube.com/embed/${ID}?start=42`), 42);
  // Nonsense is ignored, not passed on.
  assert.equal(start(`https://youtu.be/${ID}?t=soon`), 0);
  assert.equal(start(`https://youtu.be/${ID}?t=-5`), 0);
});

test("things that only look like YouTube are not", () => {
  for (const url of [
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=../../etc/passwd",
    `https://www.youtube.com/watch?v=${ID}extra`,
    "https://www.youtube.com/@somechannel",
    // A playlist player: "videoseries" is eleven characters, but it is not a video.
    "https://www.youtube.com/embed/videoseries?list=PL123",
    "https://www.youtube.com/playlist?list=PL123",
    `javascript:alert("${ID}")`,
    "not a link",
    "",
  ]) {
    assert.equal(linkEmbedFor(url), null, url);
  }
});

test("links to a post on X are recognised, old domain and new", () => {
  const post = { kind: "x", id: "1790000000000000001", handle: "kikka" };
  for (const url of [
    "https://x.com/kikka/status/1790000000000000001",
    "https://twitter.com/kikka/status/1790000000000000001",
    "https://www.x.com/kikka/status/1790000000000000001",
    "https://mobile.twitter.com/kikka/status/1790000000000000001",
    "https://x.com/kikka/status/1790000000000000001?s=20&t=abc",
    "https://x.com/kikka/status/1790000000000000001/photo/1",
    "https://x.com/kikka/status/1790000000000000001/video/1",
    "https://x.com/kikka/status/1790000000000000001/",
  ]) {
    assert.deepEqual(linkEmbedFor(url), post, url);
  }
  // A share link with no author in it.
  assert.deepEqual(linkEmbedFor("https://x.com/i/status/1790000000000000001"), { kind: "x", id: "1790000000000000001", handle: "" });
  assert.deepEqual(linkEmbedFor("https://x.com/i/web/status/1790000000000000001"), { kind: "x", id: "1790000000000000001", handle: "" });
});

test("things that only look like a post on X are not", () => {
  for (const url of [
    "https://x.com.evil.example/kikka/status/1790000000000000001",
    "https://evilx.com/kikka/status/1790000000000000001",
    "https://x.com/kikka",
    "https://x.com/kikka/status/not-a-number",
    "https://x.com/kikka/status/123abc",
    "https://x.com/kikka/status/1790000000000000001/../../../evil",
    "https://x.com/kikka/likes/1790000000000000001",
    "https://x.com/a/b/status/1790000000000000001",
    "https://x.com/search?q=status/1790000000000000001",
    "https://x.com/way_too_long_for_a_handle/status/1790000000000000001",
    "https://x.com/kikka/status/" + "9".repeat(25),
    "http://x.com/kikka/status/1790000000000000001/photo/9/extra",
  ]) {
    assert.equal(linkEmbedFor(url), null, url);
  }
});

test("the YouTube player loads from the no-cookie domain and starts where the link points", () => {
  const url = new URL(youtubePlayerUrl(ID, 0, true));
  assert.equal(url.origin, "https://www.youtube-nocookie.com");
  assert.equal(url.pathname, `/embed/${ID}`);
  // The click that loads it is the click to play.
  assert.equal(url.searchParams.get("autoplay"), "1");
  assert.equal(url.searchParams.get("playsinline"), "1");
  assert.equal(url.searchParams.has("start"), false);
  assert.equal(new URL(youtubePlayerUrl(ID, 90, true)).searchParams.get("start"), "90");
  // A player that comes back into view (after scrolling away) must not start by itself.
  assert.equal(new URL(youtubePlayerUrl(ID, 0, false)).searchParams.has("autoplay"), false);
  assert.equal(youtubeThumbnailUrl(ID), `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
});

test("the X frame asks X not to track, and only ever carries a number", () => {
  const url = new URL(xPostFrameUrl("1790000000000000001"));
  assert.equal(url.origin, X_FRAME_ORIGIN);
  assert.equal(url.pathname, "/embed/Tweet.html");
  assert.equal(url.searchParams.get("id"), "1790000000000000001");
  assert.equal(url.searchParams.get("dnt"), "true");
  assert.equal(url.searchParams.get("theme"), "dark");
});

// What X's frame posts to the page once the post has rendered (seen in a browser).
const resize = (id: string, height: unknown) => ({
  "twttr.embed": { jsonrpc: "2.0", method: "twttr.private.resize", id: "embed-0", params: [{ width: 480, height, data: { tweet_id: id } }] },
});

test("the X frame says how tall the post is; nothing else is believed", () => {
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, resize("20", 225), "20"), 225);
  // The same message as a string, which some versions send.
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, JSON.stringify(resize("20", 225)), "20"), 225);
  // Another site, another post, another message, or a silly size.
  assert.equal(xFrameHeight("https://evil.example", resize("20", 225), "20"), null);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, resize("21", 225), "20"), null);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, { "twttr.embed": { method: "twttr.private.rendered", params: [{ data: { tweet_id: "20" } }] } }, "20"), null);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, resize("20", "tall"), "20"), null);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, "not json", "20"), null);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, null, "20"), null);
  // A huge or tiny value is clamped, so a frame can't take over the chat or vanish.
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, resize("20", 99999), "20"), 900);
  assert.equal(xFrameHeight(X_FRAME_ORIGIN, resize("20", 3), "20"), 120);
});

test("each link in each message is opened on its own", () => {
  assert.notEqual(embedKey("m1", "https://youtu.be/a"), embedKey("m2", "https://youtu.be/a"));
  assert.notEqual(embedKey("m1", "https://youtu.be/a"), embedKey("m1", "https://youtu.be/b"));
});

const youtube = { kind: "youtube", id: ID, start: 0 } as const;
const xPost = { kind: "x", id: "20", handle: "jack" } as const;

test("a YouTube card with a preview is as tall closed as it is playing, and follows the chat's width", () => {
  const closed = embedRowPx(youtube, { showPreview: true, openHeight: undefined, textWidth: 884 });
  const playing = embedRowPx(youtube, { showPreview: true, openHeight: 1, textWidth: 884 });
  assert.equal(closed, playing);
  // 480 wide at 16:9 is 270 tall, plus the caption and the gap above.
  assert.equal(closed, 270 + 44 + 6);
  // On a phone the card is as wide as the text column, so it is shorter.
  assert.equal(embedRowPx(youtube, { showPreview: true, openHeight: undefined, textWidth: 328 }), Math.ceil((328 * 9) / 16) + 44 + 6);
  // Before the chat has been measured, room for the full-size card is kept.
  assert.equal(embedRowPx(youtube, { showPreview: true, openHeight: undefined, textWidth: 0 }), 270 + 44 + 6);
});

test("without a preview a link is a small button until it is opened", () => {
  assert.equal(embedRowPx(youtube, { showPreview: false, openHeight: undefined, textWidth: 884 }), EMBED_CHIP_PX);
  assert.equal(embedRowPx(youtube, { showPreview: false, openHeight: 1, textWidth: 884 }), 270 + 44 + 6);
  // A post on X never has a preview: X gives the app nothing to show before the click.
  assert.equal(embedRowPx(xPost, { showPreview: true, openHeight: undefined, textWidth: 884 }), EMBED_CHIP_PX);
  assert.equal(embedRowPx(xPost, { showPreview: false, openHeight: undefined, textWidth: 884 }), EMBED_CHIP_PX);
});

test("an opened post on X is as tall as X says it is", () => {
  assert.equal(embedRowPx(xPost, { showPreview: true, openHeight: X_FRAME_START_PX, textWidth: 884 }), X_FRAME_START_PX + 44 + 6);
  assert.equal(embedRowPx(xPost, { showPreview: true, openHeight: 612, textWidth: 884 }), 612 + 44 + 6);
});

test("opening a card is for the chat it happened in: leaving that chat closes everything", () => {
  const key = embedKey("m1", "https://youtu.be/a");
  const opened = withEmbedHeight({ chatId: "", heights: NO_OPEN_EMBEDS }, "general", key, 1);
  assert.equal(openHeightsIn(opened, "general").get(key), 1);
  // Another chat sees nothing open, so coming back later never loads a player without a press.
  assert.equal(openHeightsIn(opened, "random").size, 0);
  // Opening something in the other chat forgets the first chat's open cards.
  const moved = withEmbedHeight(opened, "random", embedKey("m9", "https://x.com/a/status/1"), 320);
  assert.equal(openHeightsIn(moved, "general").size, 0);
  assert.equal(openHeightsIn(moved, "random").size, 1);
});

test("resizing and closing a card change only that card, and nothing changes when nothing changed", () => {
  const video = embedKey("m1", "https://youtu.be/a");
  const post = embedKey("m2", "https://x.com/a/status/1");
  let state = withEmbedHeight({ chatId: "", heights: NO_OPEN_EMBEDS }, "general", video, 1);
  state = withEmbedHeight(state, "general", post, 320);
  const resized = withEmbedHeight(state, "general", post, 412);
  assert.equal(openHeightsIn(resized, "general").get(post), 412);
  assert.equal(openHeightsIn(resized, "general").get(video), 1);
  const closed = withEmbedHeight(resized, "general", post, undefined);
  assert.equal(openHeightsIn(closed, "general").has(post), false);
  assert.equal(openHeightsIn(closed, "general").get(video), 1);
  // The same value again returns the same object, so the list is not re-laid out for nothing.
  assert.equal(withEmbedHeight(resized, "general", post, 412), resized);
  assert.equal(withEmbedHeight(closed, "general", post, undefined), closed);
  // And a chat with nothing open always hands back the same empty map.
  assert.equal(openHeightsIn(closed, "random"), openHeightsIn(closed, "elsewhere"));
});

test("going to another chat and straight back finds every card closed", () => {
  const key = embedKey("m1", "https://youtu.be/a");
  const opened = withEmbedHeight(enteringChat({ chatId: "", heights: NO_OPEN_EMBEDS }, "general"), "general", key, 1);
  // Staying in the chat changes nothing (the same object, so nothing re-renders).
  assert.equal(enteringChat(opened, "general"), opened);
  const away = enteringChat(opened, "random");
  assert.equal(openHeightsIn(away, "random").size, 0);
  const back = enteringChat(away, "general");
  assert.equal(openHeightsIn(back, "general").size, 0, "nothing opened earlier is open again");
});
