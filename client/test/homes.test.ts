import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOME_URL,
  homeIdForUrl,
  loadActiveHomeId,
  loadHomes,
  normalizeHomeUrl,
  saveActiveHomeId,
  saveHomes,
  setHomeToken,
  upsertHome,
  type OhiyoHome,
} from "../src/lib/homes.ts";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

test("normalizeHomeUrl accepts bare hosts and strips paths", () => {
  assert.equal(normalizeHomeUrl("example.com/some/path?x=1#hash"), "https://example.com");
  assert.equal(normalizeHomeUrl("http://localhost:3000/api/v1"), "http://localhost:3000");
  assert.equal(normalizeHomeUrl(""), "http://localhost:3000");
});

test("normalizeHomeUrl supports local and onion custom homes", () => {
  assert.equal(normalizeHomeUrl("http://127.0.0.1:3000/api/v1"), "http://127.0.0.1:3000");
  assert.equal(normalizeHomeUrl("http://ohiyoprivateexample.onion/invite"), "http://ohiyoprivateexample.onion");
  assert.equal(homeIdForUrl("http://ohiyoprivateexample.onion"), "ohiyoprivateexample.onion");
});

test("upsertHome adds newest first and preserves existing token", () => {
  const homes: OhiyoHome[] = [{ id: homeIdForUrl("https://a.test"), name: "A", url: "https://a.test", token: "tok" }];
  const updated = upsertHome(homes, { url: "https://a.test/path", name: "Renamed" });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].url, "https://a.test");
  assert.equal(updated[0].name, "Renamed");
  assert.equal(updated[0].token, "tok");

  const withNew = upsertHome(updated, { url: "b.test" });
  assert.equal(withNew[0].url, "https://b.test");
  assert.equal(withNew[1].url, "https://a.test");
});

test("loadHomes migrates the legacy single token to the default home", () => {
  localStorage.setItem("token", "legacy-token");
  const homes = loadHomes();
  const def = homes.find((h) => h.url === DEFAULT_HOME_URL);
  assert.equal(def?.token, "legacy-token");
  assert.equal(localStorage.getItem("token"), null);
});

test("setHomeToken and active-home persistence are scoped by home id", () => {
  const homes = upsertHome(loadHomes(), { url: "https://self.example", token: null });
  saveHomes(homes);
  saveActiveHomeId(homes[0].id);
  assert.equal(loadActiveHomeId(homes), homes[0].id);

  const updated = setHomeToken(homes, homes[0].id, "self-token");
  assert.equal(updated[0].token, "self-token");
  assert.equal(updated.find((h) => h.id !== homes[0].id)?.token, null);
});
