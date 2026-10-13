// Which chats have an unsent draft, for the pencil beside them in the sidebar. A draft in a
// chat that isn't encrypted is stored (it survives a reload); one in an encrypted chat stays
// in memory only, so its pencil shows only until a reload.
//   node --experimental-strip-types --test test/draftIds.test.ts

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Just enough of window.localStorage for the drafts module (the Storage API it uses).
class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const storage = new FakeStorage();
(globalThis as Record<string, unknown>).localStorage = storage;

const { persistDraft, getDraftIds, subscribeDraftIds, dropDraftsEnteringEncryptedMode, forgetAllDrafts } = await import(
  "../src/lib/drafts.ts"
);

beforeEach(() => {
  forgetAllDrafts();
});

test("a stored draft from before a reload counts", () => {
  storage.setItem("kc:draft:c-old", "half a thought");
  storage.setItem("kc:draft:c-blank", "   ");
  storage.setItem("unrelated", "x");
  forgetAllDrafts({ keepStored: true }); // as on a fresh page: nothing read yet
  const ids = getDraftIds();
  assert.equal(ids.has("c-old"), true);
  assert.equal(ids.has("c-blank"), false);
  assert.equal(ids.has("unrelated"), false);
});

test("typing makes a draft; sending or clearing it removes it", () => {
  persistDraft("c1", "hello", false);
  assert.equal(getDraftIds().has("c1"), true);
  persistDraft("c1", "  ", false);
  assert.equal(getDraftIds().has("c1"), false);
});

test("an encrypted chat's draft shows a pencil but is never written to storage", () => {
  persistDraft("e1", "secret plans", true);
  assert.equal(getDraftIds().has("e1"), true);
  assert.equal(storage.getItem("kc:draft:e1"), null);
});

test("a chat turning encrypted loses its stored copy but keeps its pencil", () => {
  persistDraft("c2", "started before the lock", false);
  dropDraftsEnteringEncryptedMode(new Set(), new Set(["c2"]));
  assert.equal(storage.getItem("kc:draft:c2"), null);
  assert.equal(getDraftIds().has("c2"), true);
});

test("listeners hear when a chat gains or loses a draft, not on every keystroke", () => {
  let calls = 0;
  const stop = subscribeDraftIds(() => {
    calls += 1;
  });
  persistDraft("c3", "h", false);
  persistDraft("c3", "he", false);
  persistDraft("c3", "hey", false);
  assert.equal(calls, 1);
  persistDraft("c3", "", false);
  assert.equal(calls, 2);
  stop();
  persistDraft("c3", "again", false);
  assert.equal(calls, 2);
});

test("the set keeps its identity until something changes (safe for useSyncExternalStore)", () => {
  persistDraft("c4", "x", false);
  const a = getDraftIds();
  persistDraft("c4", "xy", false);
  assert.equal(getDraftIds(), a);
  persistDraft("c5", "y", false);
  assert.notEqual(getDraftIds(), a);
});

test("signing out forgets every draft", () => {
  persistDraft("c6", "x", false);
  persistDraft("e6", "y", true);
  forgetAllDrafts();
  assert.equal(getDraftIds().size, 0);
  assert.equal(storage.getItem("kc:draft:c6"), null);
});
