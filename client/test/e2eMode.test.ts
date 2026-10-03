// Tests for when a chat enters encrypted mode, and which peer a 1:1 chat encrypts to.
// Fails closed: in a DM or group DM a well-formed ciphertext envelope (or a message that
// actually decrypted) switches the chat to encrypted mode; a server channel never
// switches, and content that merely starts with an envelope prefix changes nothing.
//   node --experimental-strip-types --test test/e2eMode.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { isWellFormedEnvelope, pickDmPeer, shouldEnterEncryptedMode, withoutServerChannels } from "../src/lib/e2eMode.ts";
import { buildDistribution, groupEncrypt, setSenderKeyBackend } from "../src/lib/senderKeys.ts";

const b64 = (s: string) => Buffer.from(s, "binary").toString("base64");

// A sig2 envelope exactly as signal.ts encryptFor builds it.
const SIG2 = `sig2.${b64(
  JSON.stringify({ s: 1234567, r: { "6f0c2a8e-1111-4c4c-9999-0123456789ab.42": { t: 3, b: b64("\x33\x0a\x21binary-body") } } }),
)}`;
const SIG1 = `sig1.3.${b64("\x33\x0a\x21binary-body")}`;

async function realGroupEnvelope(): Promise<string> {
  const m = new Map<string, string>();
  setSenderKeyBackend({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
  await buildDistribution("g1");
  return (await groupEncrypt("g1", "hello"))!;
}

const FAKES = [
  "sig2.hello",
  "sig2.",
  `sig2.${b64("{}")}`,
  `sig2.${b64(JSON.stringify({ s: 1, r: {} }))}`,
  `sig2.${b64(JSON.stringify({ s: 1, r: { "u.1": { t: 3, b: "not base64!" } } }))}`,
  "sig1.3.",
  "sig1.9.AAAA",
  "grp1.",
  "grp1.hello",
  `grp1.${b64("{}")}`,
  // Header-only: enough for the recovery header parser, but no ciphertext or signature.
  `grp1.${b64(JSON.stringify({ kid: 1, it: 0 }))}`,
];

test("real sig2, sig1 and grp1 envelopes are well-formed", async () => {
  assert.equal(isWellFormedEnvelope(SIG2), true);
  assert.equal(isWellFormedEnvelope(SIG1), true);
  assert.equal(isWellFormedEnvelope(await realGroupEnvelope()), true);
});

test("content that only starts with an envelope prefix is not well-formed", () => {
  for (const fake of FAKES) assert.equal(isWellFormedEnvelope(fake), false, fake);
  assert.equal(isWellFormedEnvelope("hello sig2.x"), false);
});

test("a server channel never enters encrypted mode, whatever the content", async () => {
  const grp = await realGroupEnvelope();
  for (const type of ["text", "voice", undefined] as const) {
    assert.equal(shouldEnterEncryptedMode(type, [SIG2, grp], false), false);
    assert.equal(shouldEnterEncryptedMode(type, [SIG2], true), false);
  }
});

test("a DM with only a prefix-only fake does not enter encrypted mode", () => {
  for (const fake of FAKES) assert.equal(shouldEnterEncryptedMode("dm", ["hi", fake], false), false, fake);
});

test("a DM with a well-formed envelope enters encrypted mode even if it did not decrypt here", () => {
  assert.equal(shouldEnterEncryptedMode("dm", ["hi", SIG2], false), true);
  assert.equal(shouldEnterEncryptedMode("dm", [SIG1], false), true);
});

test("a DM with a message that decrypted enters encrypted mode", () => {
  // e.g. a legacy static-key `v1.` message that decrypted on this device.
  assert.equal(shouldEnterEncryptedMode("dm", ["v1.AAAA.BBBB"], true), true);
});

test("a group DM with a well-formed group envelope enters encrypted mode", async () => {
  assert.equal(shouldEnterEncryptedMode("group_dm", [await realGroupEnvelope()], false), true);
  assert.equal(shouldEnterEncryptedMode("group_dm", ["grp1.hello"], false), false);
});

test("the 1:1 peer is the single other participant, never guessed", () => {
  const me = { id: "me" };
  const peer = { id: "peer" };
  assert.equal(pickDmPeer([me, peer], "me"), "peer");
  assert.equal(pickDmPeer([peer, me], "me"), "peer");
  assert.equal(pickDmPeer([me], "me"), undefined, "a chat with only me has no peer");
  assert.equal(pickDmPeer([me, peer, { id: "third" }], "me"), undefined, "not a 1:1 chat");
  assert.equal(pickDmPeer([me, peer], undefined), undefined, "unknown self: can't tell who the peer is");
});

test("stored encrypted-mode entries for server channels are dropped; DMs and unknown ids are kept", () => {
  const stored = new Set(["dm-1", "group-1", "text-1", "voice-1", "unknown-1"]);
  const ready = [
    { id: "dm-1", channel_type: "dm" as const },
    { id: "group-1", channel_type: "group_dm" as const },
    { id: "text-1", channel_type: "text" as const },
    { id: "voice-1", channel_type: "voice" as const },
  ];
  assert.deepEqual([...withoutServerChannels(stored, ready)].sort(), ["dm-1", "group-1", "unknown-1"]);
  const clean = new Set(["dm-1"]);
  assert.equal(withoutServerChannels(clean, ready), clean, "unchanged set is returned as-is");
});
