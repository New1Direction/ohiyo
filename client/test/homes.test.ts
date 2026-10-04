import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOME_URL,
  homeIdForUrl,
  loadActiveHomeId,
  loadHomes,
  nameFromUrl,
  normalizeHomeUrl,
  saveActiveHomeId,
  saveHomes,
  setHomeToken,
  takeRetiredHomeDropped,
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

// The hosted backend moved off ohiyo.fly.dev with a fresh database. A home stored for that
// address can never connect again (the web build's CSP refuses it), so loading drops it.
test("loadHomes drops a home stored for the retired hosted backend, with its token", () => {
  localStorage.setItem(
    "kc:homes:v1",
    JSON.stringify([{ id: "ohiyo.fly.dev", name: "Ohiyo", url: "https://ohiyo.fly.dev", token: null }])
  );
  localStorage.setItem("kc:tok:ohiyo.fly.dev", "old-session-token");
  localStorage.setItem("kc:active-home:v1", "ohiyo.fly.dev");

  const homes = loadHomes();

  assert.equal(homes.some((h) => h.id === "ohiyo.fly.dev"), false, "the retired home is gone");
  assert.equal(localStorage.getItem("kc:tok:ohiyo.fly.dev"), null, "and so is its session token");
  const def = homeIdForUrl(DEFAULT_HOME_URL);
  assert.equal(loadActiveHomeId(homes), def, "the default home becomes the active one");
  assert.equal(homes.find((h) => h.id === def)?.token, null, "which is signed out");
  assert.equal(JSON.parse(localStorage.getItem("kc:homes:v1") ?? "[]").some((h: OhiyoHome) => h.id === "ohiyo.fly.dev"), false);
  assert.equal(takeRetiredHomeDropped(), true, "the drop is reported");
  assert.equal(takeRetiredHomeDropped(), false, "once");
});

test("loadHomes keeps other homes and reports nothing when no retired home is stored", () => {
  takeRetiredHomeDropped();
  saveHomes([{ id: homeIdForUrl("https://my.server.test"), name: "Mine", url: "https://my.server.test", token: "tok" }]);

  const homes = loadHomes();

  assert.equal(homes.find((h) => h.id === "my.server.test")?.token, "tok");
  assert.equal(takeRetiredHomeDropped(), false);
});

test("the official hosted backends are named Ohiyo", () => {
  assert.equal(nameFromUrl("https://ohiyo-server-production.up.railway.app"), "Ohiyo");
  assert.equal(nameFromUrl("https://api.ohiyo.gg"), "Ohiyo");
  assert.equal(nameFromUrl("https://my.server.test"), "my.server.test");
});
