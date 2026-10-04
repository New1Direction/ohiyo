// Tests for link previews in encrypted chats: a message decrypted on this device, or any
// message in a chat in encrypted mode, gets no preview at all — no /og request (which
// would hand the URL to the server), no preview image or YouTube iframe (which would
// expose the reader's IP to the linked host). Links themselves stay clickable.
//   node --experimental-strip-types --test test/linkPreviews.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { linkPreviewMode } from "../src/lib/linkPreviews.ts";

const EMBED = { url: "https://youtu.be/dQw4w9WgXcQ", title: "t", description: null, image: null, site_name: null, favicon: null };

test("a message decrypted on this device gets no link preview", () => {
  assert.equal(linkPreviewMode({ _encrypted: true }, false), "none");
});

test("any message in a chat in encrypted mode gets no link preview, even with server embeds", () => {
  assert.equal(linkPreviewMode({}, true), "none");
  assert.equal(linkPreviewMode({ embeds: [EMBED] }, true), "none");
  assert.equal(linkPreviewMode({ _encrypted: true, embeds: [EMBED] }, false), "none");
});

test("a plaintext message in a plaintext chat keeps today's previews", () => {
  assert.equal(linkPreviewMode({}, false), "client-fetch");
  assert.equal(linkPreviewMode({ embeds: [] }, false), "client-fetch");
  assert.equal(linkPreviewMode({ embeds: [EMBED] }, false), "server-embeds");
});
