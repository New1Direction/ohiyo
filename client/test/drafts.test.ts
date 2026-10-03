// C-M3: a draft for a chat in encrypted mode stays in memory only. Saving it never
// writes localStorage, and removes a plaintext draft stored before encryption was on.
// Drafts for other chats still persist so they survive a reload.
//   node --experimental-strip-types --test test/drafts.test.ts

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadDraft, persistDraft } from "../src/lib/drafts.ts";

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
