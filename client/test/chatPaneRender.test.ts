// Render checks for what a chat in encrypted mode shows. ChatPane is bundled with Vite
// and rendered with react-dom/server (both already client dependencies), so these run
// under plain `node --test`:
//   - C-H2: a decrypted message, or any message in a chat in encrypted mode, gets no
//     link-preview card and no embed card (no /og request, no picture or frame from
//     YouTube or X), while the links stay clickable. A YouTube video or a post on X gets
//     a play button, which loads nothing until it is pressed;
//   - item 7: no poll button and no poll composer (polls are stored unencrypted);
//   - item 8: group encryption is labelled Experimental, with the offline caveat.
//   node --experimental-strip-types --test test/chatPaneRender.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const clientRoot = join(fixtures, "..", "..");

type Props = Record<string, unknown>;
let renderChatPane: (props: Props) => string;
let renderPollComposerSlot: (props: Props) => string;
let outDir = "";

// Just enough of the browser for ChatPane's render-time reads (drafts, prefs, metrics).
function installBrowserGlobals(): void {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  const g = globalThis as Record<string, unknown>;
  g.localStorage = storage();
  g.sessionStorage = storage();
  g.window = globalThis;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document = { documentElement: { style: {} }, addEventListener() {}, removeEventListener() {}, hidden: false };
  g.location = { origin: "http://localhost:5173", href: "http://localhost:5173/" };
}

before(async () => {
  installBrowserGlobals();
  const result = await build({
    configFile: false,
    root: clientRoot,
    envDir: fixtures, // no .env here: nothing from a developer's env lands in the bundle
    logLevel: "silent",
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: [
        { find: "react-virtualized-auto-sizer", replacement: join(fixtures, "autoSizerStub.tsx") },
        // Dialogs portal into document.body, which server rendering can't do: render in place.
        { find: /^\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
      ],
    },
    ssr: { noExternal: true },
    build: { ssr: join(fixtures, "renderChatPane.tsx"), write: false },
  });
  type Chunk = { type: string; fileName: string; code?: string; isEntry?: boolean };
  const outputs = (Array.isArray(result) ? result : [result]) as { output: Chunk[] }[];
  const chunks = outputs[0].output.filter((o) => o.type === "chunk" && o.code);
  const entry = chunks.find((o) => o.isEntry);
  assert.ok(entry, "vite produced no bundle");
  outDir = await mkdtemp(join(tmpdir(), "chatpane-render-"));
  // Write every chunk (a dynamic import would split the bundle), then load the entry.
  for (const c of chunks) {
    const path = join(outDir, c.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, c.code!);
  }
  const mod = await import(pathToFileURL(join(outDir, entry.fileName)).href);
  renderChatPane = mod.renderChatPane;
  renderPollComposerSlot = mod.renderPollComposerSlot;
});

after(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const YOUTUBE = "https://youtu.be/dQw4w9WgXcQ";
const ARTICLE = "https://news.example/story";
const X_POST = "https://x.com/kikka/status/1790000000000000001";
const EMBED_TITLE = "EMBED-CARD-TITLE";
const GROUP_NOTE = "Group encryption can miss messages sent while you were offline.";
const peer = { id: "u2", username: "bea", display_name: "Bea", avatar_url: null };

function chat(type: "dm" | "group_dm", e2eEnabled: boolean, decrypted: boolean): string {
  const marks = decrypted ? { _encrypted: true } : {};
  const base = { channel_id: "c1", author: peer, created_at: 1, edited_at: null, reactions: [] };
  return renderChatPane({
    channel: { id: "c1", server_id: null, name: "chat", channel_type: type, position: 0, topic: null, created_at: 0 },
    messages: [
      // A link the client would preview itself (YouTube: an iframe, no fetch needed to show it).
      { ...base, id: "m1", content: `watch ${YOUTUBE}`, ...marks },
      // A link with a server-attached embed card.
      {
        ...base,
        id: "m2",
        content: `read ${ARTICLE}`,
        embeds: [{ url: ARTICLE, title: EMBED_TITLE, description: null, image: null, site_name: null, favicon: null }],
        ...marks,
      },
      // A post on X.
      { ...base, id: "m3", content: `lol ${X_POST}`, ...marks },
    ],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    isLoading: false,
    e2eEnabled,
    onToggleE2e() {},
  });
}

// Anything a browser would fetch from YouTube or X just by showing the chat.
const loadsFromVideoSites = (html: string) => /<iframe|ytimg\.com|youtube-nocookie\.com|platform\.twitter\.com|twimg\.com/.test(html);
// The card with the video's picture, shown where previews are allowed.
const hasPreviewCard = (html: string) => html.includes("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
// The small buttons that load a video or a post only when pressed.
const hasYouTubePlayButton = (html: string) => html.includes('aria-label="Play this YouTube video here"');
const hasXPostButton = (html: string) => html.includes('aria-label="Show this post from X here. Post by @kikka"');
const hasEmbedCard = (html: string) => html.includes(EMBED_TITLE);
const linksClickable = (html: string) => html.includes(`href="${YOUTUBE}"`) && html.includes(`href="${ARTICLE}"`);
const hasPollButton = (html: string) => html.includes('aria-label="Create a poll"');

function lockTitle(html: string): string {
  const button = /<button[^>]*aria-label="Turn (?:on|off) end-to-end encryption"[^>]*>/.exec(html)?.[0] ?? "";
  return /title="([^"]*)"/.exec(button)?.[1] ?? "";
}

function banner(html: string): string {
  const start = html.indexOf('class="kc-e2e-banner');
  return start === -1 ? "" : html.slice(start, html.indexOf("</div>", start));
}

for (const [what, html] of [
  ["a decrypted message in an encrypted chat", () => chat("dm", true, true)],
  ["a decrypted message even outside encrypted mode", () => chat("dm", false, true)],
  // Encrypted mode alone must suppress previews, without relying on `_encrypted`.
  ["a message not marked decrypted, in a chat in encrypted mode,", () => chat("dm", true, false)],
] as const) {
  test(`C-H2: ${what} renders no link-preview card`, () => {
    const out = html();
    assert.equal(hasPreviewCard(out), false, "no link-preview card");
    assert.equal(loadsFromVideoSites(out), false, "nothing is fetched from YouTube or X");
    assert.ok(linksClickable(out), "links stay clickable");
  });
  test(`C-H2: ${what} can still play a video or a post, on a click`, () => {
    const out = html();
    assert.ok(hasYouTubePlayButton(out), "a play button for the YouTube link");
    assert.ok(hasXPostButton(out), "a button for the post on X");
    assert.equal(loadsFromVideoSites(out), false, "the buttons load nothing by being shown");
  });
  test(`C-H2: ${what} renders no embed card`, () => {
    const out = html();
    assert.equal(hasEmbedCard(out), false);
    assert.ok(linksClickable(out), "links stay clickable");
  });
}

test("C-H2: the same messages in plaintext in an unencrypted chat keep both cards", () => {
  const html = chat("dm", false, false);
  assert.ok(hasPreviewCard(html), "link-preview card");
  assert.ok(hasEmbedCard(html), "embed card");
});

test("link players: a YouTube link shows its picture and a play button, and no player until it is pressed", () => {
  const html = chat("dm", false, false);
  assert.match(html, /<button[^>]*class="kc-embed__poster"[^>]*aria-label="Play YouTube video here"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /youtube-nocookie\.com/);
});

test("link players: a post on X is a button, and nothing is fetched from X until it is pressed", () => {
  const html = chat("dm", false, false);
  assert.ok(hasXPostButton(html));
  assert.doesNotMatch(html, /platform\.twitter\.com|twimg\.com/);
});

test("item 7: no poll button in encrypted mode; present otherwise", () => {
  assert.equal(hasPollButton(chat("dm", true, false)), false);
  assert.equal(hasPollButton(chat("group_dm", true, false)), false);
  assert.ok(hasPollButton(chat("dm", false, false)));
});

test("item 7: the poll composer never opens in encrypted mode; opens otherwise", () => {
  const props = { open: true, channelId: "c1", token: "t", onClose() {}, onError() {} };
  assert.equal(renderPollComposerSlot({ ...props, e2eEnabled: true }), "");
  assert.match(renderPollComposerSlot({ ...props, e2eEnabled: false }), /New poll/);
  assert.equal(renderPollComposerSlot({ ...props, open: false, e2eEnabled: false }), "");
});

test("item 8: a group DM's lock button title says Experimental, with the offline caveat", () => {
  for (const e2eEnabled of [false, true]) {
    const title = lockTitle(chat("group_dm", e2eEnabled, false));
    assert.match(title, /Experimental/, `lock title (encryption ${e2eEnabled ? "on" : "off"})`);
    assert.ok(title.includes(GROUP_NOTE), `lock title note (encryption ${e2eEnabled ? "on" : "off"})`);
  }
});

test("item 8: a group DM's encrypted banner says Experimental, with the offline caveat", () => {
  const shown = banner(chat("group_dm", true, false));
  assert.match(shown, /Switched to end-to-end encrypted\./);
  assert.match(shown, />Experimental</);
  assert.ok(shown.includes(GROUP_NOTE), "banner note");
});

test("item 8: a one-to-one DM carries no Experimental label or group caveat", () => {
  for (const e2eEnabled of [false, true]) {
    const html = chat("dm", e2eEnabled, false);
    assert.ok(lockTitle(html), "the lock button is rendered");
    assert.doesNotMatch(lockTitle(html), /Experimental/);
    assert.ok(!html.includes(GROUP_NOTE));
    assert.doesNotMatch(banner(html), /Experimental/);
  }
  assert.match(banner(chat("dm", true, false)), /Switched to end-to-end encrypted\./);
});

// I1: no Edit action for one's own decrypted message while the lock is off.
function ownMessage(e2eEnabled: boolean, decrypted: boolean): string {
  const me = { id: "u1", username: "ana", display_name: "Ana", avatar_url: null };
  return renderChatPane({
    channel: { id: "c1", server_id: null, name: "chat", channel_type: "dm", position: 0, topic: null, created_at: 0 },
    messages: [
      { id: "m1", channel_id: "c1", author: me, content: "meet at noon", created_at: 1, edited_at: null, reactions: [], ...(decrypted ? { _encrypted: true } : {}) },
    ],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    onEditMessage() {},
    isLoading: false,
    e2eEnabled,
    onToggleE2e() {},
  });
}

const hasEditButton = (html: string) => /<button[^>]*aria-label="Edit message"/.test(html);

test("item I1: no Edit for a decrypted message while the lock is off", () => {
  assert.equal(hasEditButton(ownMessage(false, true)), false);
});

test("item I1: Edit stays for a decrypted message in encrypted mode, and for plain messages", () => {
  assert.equal(hasEditButton(ownMessage(true, true)), true);
  assert.equal(hasEditButton(ownMessage(false, false)), true);
});

// I3: in-app text says only what is true today. In an encrypted chat the server stores
// ciphertext (it doesn't promise the server can never read anything), and an empty DM
// doesn't claim to be encrypted before the lock is on.
// N4: the banner speaks only for what you send here (earlier history, or the other
// person's messages while their lock is off, may be plain text).
test("item I3/N4: the encrypted-chat banner says the server stores only ciphertext for what you send", () => {
  const text = banner(chat("dm", true, false));
  assert.match(text, /Encryption is on\. The server stores only ciphertext for messages and files you send here\./);
  assert.doesNotMatch(text, /not even the server|Messages here are encrypted/);
});

function emptyDm(e2eEnabled: boolean): string {
  return renderChatPane({
    channel: { id: "c1", server_id: null, name: "dm", channel_type: "dm", position: 0, topic: null, created_at: 0 },
    messages: [],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    isLoading: false,
    e2eEnabled,
    onToggleE2e() {},
  });
}

test("item I3: an empty DM with the lock off doesn't claim its messages are encrypted", () => {
  const html = emptyDm(false);
  assert.doesNotMatch(html, /Send the first encrypted message|only relays sealed envelopes|Drop an encrypted file/);
  assert.match(html, /tap the lock/i);
});

// N1: with the lock already on, tapping it would turn encryption off, so the welcome says
// encryption is on instead of suggesting the lock.
test("item N1: an empty DM with the lock on says encryption is on and doesn't suggest the lock", () => {
  const html = emptyDm(true);
  assert.doesNotMatch(html, /tap the lock/i);
  assert.match(html, /Encryption is on: the server stores only ciphertext for messages and files you send here\./);
  assert.match(html, /<span>Encryption is on<\/span>/);
});

// M3: a watch party's video URL goes to the server unencrypted, so it isn't offered in an
// encrypted chat (like polls).
function watchableChat(type: "dm" | "group_dm", e2eEnabled: boolean): string {
  return renderChatPane({
    channel: { id: "c1", server_id: null, name: "chat", channel_type: type, position: 0, topic: null, created_at: 0 },
    messages: [],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    onWatchControl() {},
    isLoading: false,
    e2eEnabled,
    onToggleE2e() {},
  });
}

const hasWatchButton = (html: string) => html.includes('aria-label="Watch party"');

test("item M3: no watch party in encrypted mode; offered otherwise", () => {
  assert.equal(hasWatchButton(watchableChat("dm", true)), false);
  assert.equal(hasWatchButton(watchableChat("group_dm", true)), false);
  assert.ok(hasWatchButton(watchableChat("dm", false)));
});

// A member who has not set a profile picture shows the Ohiyo logo, not their initial.
const LOGO = 'viewBox="0 -23 746 746"';
function messageAvatars(html: string): string[] {
  return [...html.matchAll(/<button[^>]*class="msg-avatar[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
}

test("default avatar: a member with no picture shows the Ohiyo logo, hidden from screen readers", () => {
  const avatars = messageAvatars(chat("dm", false, false));
  assert.ok(avatars.length > 0, "the messages render avatars");
  for (const inner of avatars) {
    assert.ok(inner.includes(LOGO), "the logo is drawn");
    assert.ok(inner.includes('aria-hidden="true"'), "decorative");
    assert.equal(inner.includes('aria-label="Ohiyo"'), false, "not announced as 'Ohiyo' for every person");
    assert.equal(/>B</.test(inner), false, "no initial letter");
  }
});

test("default avatar: a member with a picture keeps it and gets no logo", () => {
  const withPic = { ...peer, avatar_url: "https://files.example/bea.png" };
  const html = renderChatPane({
    channel: { id: "c1", server_id: null, name: "chat", channel_type: "dm", position: 0, topic: null, created_at: 0 },
    messages: [{ channel_id: "c1", author: withPic, created_at: 1, edited_at: null, reactions: [], id: "m1", content: "hi" }],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    isLoading: false,
    e2eEnabled: false,
    onToggleE2e() {},
  });
  const [inner] = messageAvatars(html);
  assert.equal(inner, "", "no fallback content over a picture");
  assert.ok(html.includes("bea.png"));
});

// ||Spoilers|| used to work only for a reader who had switched on a plugin; everyone else
// saw the bars and the text. They are part of chat now, with no plugin involved.
test("spoilers: text between double bars is hidden behind a button for every reader", () => {
  const html = renderChatPane({
    channel: { id: "c1", server_id: null, name: "chat", channel_type: "dm", position: 0, topic: null, created_at: 0 },
    messages: [{ channel_id: "c1", author: peer, created_at: 1, edited_at: null, reactions: [], id: "m1", content: "the ending: ||everyone lives|| honest" }],
    currentUserId: "u1",
    token: "t",
    pluginManager: { applyMessageTransforms: (m: unknown) => m, applyTransformSend: (s: string) => s },
    serverEmojis: [],
    onSend() {},
    onToast() {},
    isLoading: false,
    e2eEnabled: false,
    onToggleE2e() {},
  });
  const spoiler = /<button[^>]*data-spoiler=""[^>]*>(.*?)<\/button>/.exec(html);
  assert.ok(spoiler, "a spoiler button is rendered");
  assert.equal(spoiler[1], "everyone lives");
  assert.match(spoiler[0], /aria-label="Spoiler, activate to reveal"/);
  const row = html.slice(html.indexOf('class="kc-msg"'));
  assert.equal(row.includes("||"), false, "the bars are not shown");
  assert.ok(row.includes("the ending: ") && row.includes(" honest"), "the text around it stays");
});
