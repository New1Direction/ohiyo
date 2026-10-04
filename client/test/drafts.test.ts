// C-M3: a draft for a chat in encrypted mode stays in memory only. Saving it never
// writes localStorage, and removes a plaintext draft stored before encryption was on.
// Drafts for other chats still persist so they survive a reload. When a chat enters
// encrypted mode, its stored draft goes even if that chat isn't open.
//   node --experimental-strip-types --test test/drafts.test.ts

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { dropDraftsEnteringEncryptedMode, loadDraft, persistDraft } from "../src/lib/drafts.ts";

const stored = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
};

beforeEach(() => stored.clear());

test("a draft in an unencrypted chat is stored and loads back", () => {
  persistDraft("c1", "half-written", false);
  assert.equal(loadDraft("c1"), "half-written");
});

test("an empty draft removes the stored one", () => {
  persistDraft("c1", "half-written", false);
  persistDraft("c1", "   ", false);
  assert.equal(stored.size, 0);
});

test("a draft in an encrypted chat is never written to localStorage", () => {
  persistDraft("c1", "secret plan", true);
  assert.equal(stored.size, 0);
});

test("saving an encrypted chat's draft removes a plaintext draft stored earlier", () => {
  persistDraft("c1", "typed before encryption", false);
  persistDraft("c1", "typed before encryption", true);
  assert.equal(stored.size, 0);
  assert.equal(loadDraft("c1"), "");
});

test("a chat entering encrypted mode loses its stored draft even when it isn't open", () => {
  persistDraft("c1", "already encrypted chat", false);
  persistDraft("c2", "typed before encryption", false);
  persistDraft("c3", "unencrypted chat", false);
  dropDraftsEnteringEncryptedMode(new Set(["c1"]), new Set(["c1", "c2"]));
  assert.equal(loadDraft("c2"), "");
  assert.equal(loadDraft("c1"), "already encrypted chat");
  assert.equal(loadDraft("c3"), "unencrypted chat");
});

test("a chat leaving encrypted mode keeps whatever is stored", () => {
  persistDraft("c1", "kept", false);
  dropDraftsEnteringEncryptedMode(new Set(["c1", "c2"]), new Set(["c2"]));
  assert.equal(loadDraft("c1"), "kept");
});
