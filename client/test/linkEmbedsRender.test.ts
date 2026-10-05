// What a link player puts on the page, closed and opened: the one frame it may load, what
// that frame is allowed to do, and that a closed card asks YouTube or X for nothing more
// than (where previews are allowed) the video's picture.
//   node --experimental-strip-types --test test/linkEmbedsRender.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Options = { showPreview: boolean; openHeight?: number; title?: string };
type Mod = { renderLinkEmbed: (url: string, options: Options) => string };
let bundle: Bundle<Mod>;

before(async () => {
  bundle = await bundleEntry<Mod>(join(fixtures, "renderLinkEmbed.tsx"));
});

after(async () => {
  await bundle?.cleanup();
});

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s";
const POST = "https://x.com/jack/status/20";
const frame = (html: string) => /<iframe[^>]*>/.exec(html)?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]?.replaceAll("&amp;", "&") ?? null;

test("a closed YouTube card shows the video's picture and names what the button plays", () => {
  const html = bundle.mod.renderLinkEmbed(VIDEO, { showPreview: true, title: "Never Gonna Give You Up" });
  assert.match(html, /<button[^>]*class="kc-embed__poster"[^>]*aria-label="Play Never Gonna Give You Up here"/);
  const img = /<img[^>]*>/.exec(html)?.[0] ?? "";
  assert.equal(attr(img, "src"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  // The picture is decoration next to the named button, and YouTube is not told which page asked.
  assert.equal(attr(img, "alt"), "");
  assert.equal(attr(img, "referrerPolicy") ?? attr(img, "referrerpolicy"), "no-referrer");
  assert.equal(frame(html), "", "no player until it is pressed");
  assert.doesNotMatch(html, />Close</);
});

test("with previews off, a closed YouTube link is a button and asks YouTube for nothing", () => {
  const html = bundle.mod.renderLinkEmbed(VIDEO, { showPreview: false });
  assert.match(html, /aria-label="Play this YouTube video here"/);
  assert.match(html, /Loads from YouTube when you press play/);
  assert.doesNotMatch(html, /<img|<iframe|ytimg|youtube-nocookie/);
});

test("an opened YouTube card holds YouTube's no-cookie player and a way to close it", () => {
  const html = bundle.mod.renderLinkEmbed(VIDEO, { showPreview: true, openHeight: 1, title: "Never Gonna Give You Up" });
  const tag = frame(html);
  const src = new URL(attr(tag, "src") ?? "");
  assert.equal(src.origin, "https://www.youtube-nocookie.com");
  assert.equal(src.pathname, "/embed/dQw4w9WgXcQ");
  assert.equal(src.searchParams.get("start"), "43");
  // Rendered already open (as when a row scrolls back into view): it must not start by itself.
  assert.equal(src.searchParams.has("autoplay"), false);
  assert.equal(attr(tag, "title"), "Never Gonna Give You Up");
  assert.equal(attr(tag, "allow"), "autoplay; encrypted-media; picture-in-picture; fullscreen");
  // YouTube refuses to play for a page that hides where the player is embedded.
  assert.equal(attr(tag, "referrerPolicy") ?? attr(tag, "referrerpolicy"), "strict-origin-when-cross-origin");
  // Like X's frame, it cannot navigate the page it sits in.
  assert.ok(!(attr(tag, "sandbox") ?? "allow-top-navigation").includes("allow-top-navigation"));
  assert.ok((attr(tag, "sandbox") ?? "").split(" ").includes("allow-scripts"));
  assert.match(html, /<button[^>]*class="kc-embed__close"[^>]*>Close<\/button>/);
  // The title still links to the video itself, in a new tab.
  assert.match(html, /<a href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=43s" target="_blank" rel="noopener noreferrer"/);
});

test("a closed post on X is a button that says whose post it is and that it loads from X", () => {
  for (const showPreview of [true, false]) {
    const html = bundle.mod.renderLinkEmbed(POST, { showPreview });
    assert.match(html, /aria-label="Show this post from X here\. Post by @jack"/);
    assert.match(html, /loads from X when you press it/);
    assert.doesNotMatch(html, /<img|<iframe|twitter\.com|twimg/);
  }
});

test("an opened post on X is X's own frame, as tall as X said, and it cannot move the page", () => {
  const html = bundle.mod.renderLinkEmbed(POST, { showPreview: true, openHeight: 412 });
  const tag = frame(html);
  assert.equal(attr(tag, "src"), "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true&theme=dark");
  assert.match(attr(tag, "style") ?? "", /height:\s*412px/);
  const sandbox = (attr(tag, "sandbox") ?? "").split(" ");
  assert.ok(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin"));
  for (const power of ["allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-forms", "allow-modals", "allow-downloads"]) {
    assert.ok(!sandbox.includes(power), `${power} is not granted`);
  }
  assert.match(html, /<a href="https:\/\/x\.com\/jack\/status\/20" target="_blank" rel="noopener noreferrer"[^>]*>Open on X<\/a>/);
  assert.match(html, />Close<\/button>/);
});

test("a title cannot inject markup into the card", () => {
  const html = bundle.mod.renderLinkEmbed(VIDEO, { showPreview: true, title: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

// The frames above only load if the page's security policy lets them, and the policy lets
// nothing else be framed: if a bug ever let a message choose a frame's address, the
// browser would still refuse it.
test("the web app and the desktop app allow the two players' frames, no other site, and no outside scripts", () => {
  const client = join(fixtures, "..", "..");
  const web = readFileSync(join(client, "vite.config.ts"), "utf8");
  assert.match(web, /"frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/platform\.twitter\.com"/);
  assert.doesNotMatch(web, /"frame-src https:"/);
  assert.match(web, /"script-src 'self'"/);
  const desktop = JSON.parse(readFileSync(join(client, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp as string;
  const frameSrc = desktop.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src ")) ?? "";
  assert.ok(frameSrc.split(" ").includes("https://www.youtube-nocookie.com"), frameSrc);
  assert.ok(frameSrc.split(" ").includes("https://platform.twitter.com"), frameSrc);
  assert.match(desktop, /script-src 'self'(;|$)/);
});
