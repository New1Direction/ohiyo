// The command palette offers Instant Servers only on a home that can make them. The hosted
// service can't, and its palette used to offer them anyway, answering "not available".
//   node --experimental-strip-types --test test/instantServers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { availabilityFrom, offersInstantServers } from "../src/lib/instantServers.ts";

test("the server's answer says whether Instant Servers are on", () => {
  assert.equal(availabilityFrom({ available: true }), "on");
  assert.equal(availabilityFrom({ available: false }), "off");
});

test("an answer it can't read changes nothing", () => {
  // An older or self-hosted server has no such endpoint; its palette stays as it was.
  for (const body of [null, undefined, {}, { available: "no" }, [], "false"]) {
    assert.equal(availabilityFrom(body), "unknown", JSON.stringify(body));
  }
});

test("the palette offers Instant Servers unless the home says they're off", () => {
  assert.equal(offersInstantServers("off"), false);
  assert.equal(offersInstantServers("on"), true);
  assert.equal(offersInstantServers("unknown"), true);
});

test("the palette's Instant Servers entry follows that answer", () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");
  const at = app.indexOf('id: "action-instant-servers"');
  assert.ok(at !== -1, "the palette still has the entry where they're on");
  assert.match(app.slice(Math.max(0, at - 400), at), /offersInstantServers\(/);
});
