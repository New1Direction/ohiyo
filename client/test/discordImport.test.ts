// Discord import: the server ignores media_root on the local Discrawl import route, so
// the client no longer sends it; and the modal only offers an import the capability route
// reports as available to this user (local and managed import are operator-only).
//   node --experimental-strip-types --test test/discordImport.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { discrawlRequest, importOptions } from "../src/lib/discordImport.ts";

test("the archive import request carries no media_root", () => {
  assert.deepEqual(discrawlRequest({ dbPath: " /data/discrawl.db ", guildId: " ", history: "All" }), {
    db_path: "/data/discrawl.db",
    guild_id: null,
    history: "All",
  });
  assert.deepEqual(discrawlRequest({ dbPath: "/d.db", guildId: "123456", history: "Last90Days" }), {
    db_path: "/d.db",
    guild_id: "123456",
    history: "Last90Days",
  });
});

const cap = (enabled: boolean, managed_enabled: boolean) => ({ enabled, managed_enabled, mode: "local_discrawl_archive", message: "" });

test("an import the capability route reports as unavailable is not offered", () => {
  assert.deepEqual(importOptions(cap(false, false)), { archive: false, managed: false });
  assert.deepEqual(importOptions(cap(true, false)), { archive: true, managed: false });
  assert.deepEqual(importOptions(cap(false, true)), { archive: false, managed: true });
});

test("nothing but the template link is offered before the capability answers, or if it fails", () => {
  assert.deepEqual(importOptions(null), { archive: false, managed: false });
});
