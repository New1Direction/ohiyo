// I2: one message that can't be decrypted, for any reason, shows the undecryptable
// placeholder and doesn't stop the rest of the channel loading. Before, a stored sender-key
// distribution with malformed key values made groupDecrypt throw, the decrypt loop had no
// per-message catch, and the whole channel loaded empty.
//   node --experimental-strip-types --test test/decryptFailure.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { decryptEach } from "../src/lib/decryptEach.ts";
import { buildDistribution, groupDecrypt, groupEncrypt, installDistribution, setSenderKeyBackend } from "../src/lib/senderKeys.ts";

function memoryBackend() {
  const m = new Map<string, string>();
  setSenderKeyBackend({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
}

// A real envelope from "us", plus a distribution for peer "alice" with the same key id
// whose verify and chain keys are malformed, so decrypting it as Alice's message reaches
// the stored keys.
async function malformedPeerKeys(): Promise<string> {
  memoryBackend();
  const own = JSON.parse(await buildDistribution("g1")) as { kid: number; ep: number };
  const wire = (await groupEncrypt("g1", "hello"))!;
  installDistribution("g1", "alice", JSON.stringify({ kid: own.kid, ck: "%%not-base64%%", it: 0, vk: "%%not-base64%%", ep: own.ep }));
  return wire;
}

test("a malformed stored sender key makes groupDecrypt return null instead of throwing", async () => {
  const wire = await malformedPeerKeys();
  assert.equal(await groupDecrypt("g1", "alice", wire), null);
});

test("a message whose decrypt throws becomes the placeholder and the others still load", async () => {
  const wire = await malformedPeerKeys();
  const msgs = [
    { id: "m1", content: "plain before" },
    { id: "m2", content: wire },
    { id: "m3", content: "plain after" },
  ];
  const out = await decryptEach(
    msgs,
    async (m) => {
      if (m.id === "m2") throw new Error("malformed sender key"); // any reason at all
      return { ...m, content: m.content.toUpperCase() };
    },
    (m) => ({ ...m, content: "" }),
  );
  assert.deepEqual(out, [
    { id: "m1", content: "PLAIN BEFORE" },
    { id: "m2", content: "" },
    { id: "m3", content: "PLAIN AFTER" },
  ]);
});

test("messages are decrypted one after another, in order", async () => {
  const order: string[] = [];
  await decryptEach(
    ["a", "b", "c"],
    async (m) => {
      order.push(`start ${m}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end ${m}`);
      return m;
    },
    (m) => m,
  );
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});
