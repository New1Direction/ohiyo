// What a watch party shows. The server lets only the host drive or end it, so a guest is
// told so and gets no End button (it did nothing). A YouTube party is the no-cookie embed
// in an <iframe>, driven by messages: no script from YouTube is loaded into the app, which
// the web build's CSP would block anyway (that left YouTube parties as an empty box).
//   node --experimental-strip-types --test test/watchPartyRender.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = { renderWatchParty: (props: Record<string, unknown>) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderWatchParty.tsx"));
});
after(async () => {
  await bundle?.cleanup();
});

const session = (url: string) => ({ url, paused: true, position: 0, updated_at: 1000, host_id: "host-1", server_time: 1000 });
const MP4 = "https://example.com/clip.mp4";
const YT = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const render = (url: string, isHost: boolean) =>
  bundle.mod.renderWatchParty({ session: session(url), isHost, onControl: () => {} });
const hasEnd = (html: string) => />\s*End\s*<\/button>/.test(html);

test("the host can end the party", () => {
  const html = render(MP4, true);
  assert.equal(hasEnd(html), true);
  assert.equal(html.includes("Only the host controls playback"), false);
});

test("a guest is told the host controls playback and gets no End button", () => {
  const html = render(MP4, false);
  assert.equal(hasEnd(html), false);
  assert.ok(html.includes("Only the host controls playback"));
});

test("a direct video link plays in a video element", () => {
  const html = render(MP4, true);
  assert.match(html, /<video[^>]*src="https:\/\/example\.com\/clip\.mp4"/);
  assert.equal(html.includes("<iframe"), false);
});

test("a YouTube link is the no-cookie embed in an iframe that may autoplay", () => {
  for (const isHost of [true, false]) {
    const html = render(YT, isHost);
    const src = html.match(/<iframe[^>]*src="([^"]+)"/)?.[1].replace(/&amp;/g, "&") ?? "";
    const url = new URL(src);
    assert.equal(url.origin, "https://www.youtube-nocookie.com");
    assert.equal(url.pathname, "/embed/aqz-KE-bpKQ");
    assert.equal(url.searchParams.get("enablejsapi"), "1");
    assert.match(html, /<iframe[^>]*allow="[^"]*autoplay/);
    assert.equal(html.includes("<video"), false);
  }
});
