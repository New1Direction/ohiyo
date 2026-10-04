// Watch party sync. The server holds the session (position, and when that position was
// true on ITS clock); each client works out the live position. Using the device's own
// clock against the server's timestamp put a guest whose clock was 20 s fast 20 s ahead,
// so a session is first moved onto the device's clock using the server's `server_time`.
// Only the host drives playback: the server ignores everyone else's play/pause/seek/stop.
//   node --experimental-strip-types --test test/watchSync.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { isWatchHost, livePosition, onLocalClock, youtubeId } from "../src/lib/watchSync.ts";

const session = (over: Record<string, unknown> = {}) => ({
  url: "https://example.com/v.mp4",
  paused: false,
  position: 5,
  updated_at: 990,
  host_id: "host-1",
  server_time: 1000,
  ...over,
});

test("a paused session sits at its stored position", () => {
  assert.equal(livePosition(session({ paused: true }), 5000), 5);
});

test("a playing session advances with the clock", () => {
  assert.equal(livePosition(session({ server_time: undefined }), 1000), 15);
});

test("a device whose clock is 20 s fast still lands on the server's position", () => {
  // Server: position 5 was true at 990, and it is 1000 now, so the live position is 15.
  // This device thinks it is 1020.
  const local = onLocalClock(session(), 1020);
  assert.equal(local.updated_at, 1010);
  assert.equal(livePosition(local, 1020), 15);
  // Three seconds later on this device it is three seconds further on.
  assert.equal(livePosition(local, 1023), 18);
});

test("a device whose clock is slow is corrected the same way", () => {
  const local = onLocalClock(session(), 400);
  assert.equal(livePosition(local, 400), 15);
});

test("a session from an older server (no server_time) is left as it is", () => {
  for (const server_time of [undefined, 0]) {
    const s = session({ server_time });
    assert.equal(onLocalClock(s, 1020).updated_at, 990);
  }
});

test("only the member who started the party is its host", () => {
  assert.equal(isWatchHost(session(), "host-1"), true);
  assert.equal(isWatchHost(session(), "someone-else"), false);
  assert.equal(isWatchHost(session(), ""), false);
  assert.equal(isWatchHost(session(), undefined), false);
});

test("youtubeId reads watch, share, embed and shorts links, and nothing else", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=3"), "aqz-KE-bpKQ");
  assert.equal(youtubeId("https://youtu.be/aqz-KE-bpKQ"), "aqz-KE-bpKQ");
  assert.equal(youtubeId("https://www.youtube.com/embed/aqz-KE-bpKQ"), "aqz-KE-bpKQ");
  assert.equal(youtubeId("https://youtube.com/shorts/abc123XYZ_-"), "abc123XYZ_-");
  assert.equal(youtubeId("https://example.com/watch?v=aqz-KE-bpKQ"), null);
  assert.equal(youtubeId("https://notyoutube.com/watch?v=aqz-KE-bpKQ"), null);
  assert.equal(youtubeId("not a url"), null);
});
