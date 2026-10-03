// M4: after a reload, a DM whose loaded page has no ciphertext has no known peer (the peer
// was only learned while decrypting), so turning the lock on and sending failed with
// "your friend needs to open Ohiyo". The peer is now learned from the chat's participant
// list when it isn't known.
//   node --experimental-strip-types --test test/dmPeer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDmPeer } from "../src/lib/e2eMode.ts";

test("a known peer is used without asking the server", async () => {
  let asked = false;
  const peer = await resolveDmPeer("u2", async () => ((asked = true), []), "u1");
  assert.equal(peer, "u2");
  assert.equal(asked, false);
});

test("an unknown peer is learned from the participant list", async () => {
  assert.equal(await resolveDmPeer(undefined, async () => [{ id: "u1" }, { id: "u2" }], "u1"), "u2");
});

test("no peer when the list can't be fetched or isn't one other person", async () => {
  assert.equal(await resolveDmPeer(undefined, async () => Promise.reject(new Error("offline")), "u1"), undefined);
  assert.equal(await resolveDmPeer(undefined, async () => [{ id: "u1" }, { id: "u2" }, { id: "u3" }], "u1"), undefined);
  assert.equal(await resolveDmPeer(undefined, async () => [{ id: "u2" }], undefined), undefined);
});
