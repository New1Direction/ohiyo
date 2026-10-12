// When someone deletes their account, the people they talked with see it at once: their
// messages leave the screen, and a 1:1 chat with them is named "Deleted account" with no
// way to reply. After a reload the same follows from Ready, which names every 1:1 chat's
// other person (dm_peers) and so leaves out the ones whose person is gone.
//   node --experimental-strip-types --test test/deletedAccounts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { dmsWith, dmsWithNoPeer, withoutAuthor } from "../src/lib/deletedAccounts.ts";
import type { Channel, Message, PublicUser } from "../src/api.ts";

const dm = (id: string, channel_type: "dm" | "group_dm" = "dm") => ({ id, channel_type, name: "dm" }) as Channel;
const user = (id: string) => ({ id, username: id, display_name: id, avatar_url: null }) as PublicUser;
const msg = (id: string, author: string) => ({ id, content: "hi", author: user(author) }) as Message;

test("after a reload, a 1:1 chat Ready names nobody for is with a deleted account", () => {
  const dms = [dm("d1"), dm("d2"), dm("g1", "group_dm")];
  assert.deepEqual(dmsWithNoPeer(dms, { d1: user("ann") }), ["d2"]);
});

test("the 1:1 chats with the person who left", () => {
  const peers = { d1: user("ann"), d2: user("bea"), d3: user("ann") };
  assert.deepEqual(dmsWith(peers, "ann").sort(), ["d1", "d3"]);
  assert.deepEqual(dmsWith(peers, "cal"), []);
});

test("their messages leave the screen; everyone else's stay", () => {
  const shown = [msg("m1", "ann"), msg("m2", "bea"), msg("m3", "ann")];
  assert.deepEqual(withoutAuthor(shown, "ann").map((m) => m.id), ["m2"]);
});
