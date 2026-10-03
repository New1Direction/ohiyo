// Render checks for what a chat in encrypted mode shows. ChatPane is bundled with Vite
// and rendered with react-dom/server (both already client dependencies), so these run
// under plain `node --test`:
//   - C-H2: a decrypted message, or any message in a chat in encrypted mode, gets no
//     link-preview card and no embed card
//     (no /og request, no YouTube iframe), while the links stay clickable;
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

const hasPreviewCard = (html: string) => html.includes("youtube-nocookie.com/embed/");
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
    assert.equal(hasPreviewCard(out), false, "no link-preview card / YouTube iframe");
    assert.ok(linksClickable(out), "links stay clickable");
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
