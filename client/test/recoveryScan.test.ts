// C-H6, second writer: the restore preview in Settings scans recent messages into the
// bounded recovery inventory. Like the chat's own writer, it records only well-formed
// envelopes in DMs and group DMs, and it doesn't scan server channels at all, so
// server-channel content can't evict real entries.
//   node --experimental-strip-types --test test/recoveryScan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { recoverableMessages, recoveryScanChannels } from "../src/lib/e2eMode.ts";

const b64 = (s: string) => Buffer.from(s, "binary").toString("base64");
// A sig2 envelope exactly as signal.ts encryptFor builds it.
const SIG2 = `sig2.${b64(
  JSON.stringify({ s: 1234567, r: { "6f0c2a8e-1111-4c4c-9999-0123456789ab.42": { t: 3, b: b64("\x33\x0a\x21binary-body") } } }),
)}`;

test("the restore preview scans only DMs and group DMs", () => {
  const channels = [
    { id: "t", channel_type: "text" as const },
    { id: "v", channel_type: "voice" as const },
    { id: "d", channel_type: "dm" as const },
    { id: "g", channel_type: "group_dm" as const },
  ];
  assert.deepEqual(recoveryScanChannels(channels).map((c) => c.id), ["d", "g"]);
});

test("in a DM only well-formed envelopes are recorded", () => {
  const messages = [
    { id: "1", content: SIG2 },
    { id: "2", content: `sig2.${b64("{}")}` }, // parses as a header, but isn't an envelope
    { id: "3", content: "grp1.not-an-envelope" },
    { id: "4", content: "plain text" },
  ];
  assert.deepEqual(recoverableMessages("dm", messages).map((m) => m.id), ["1"]);
});

test("nothing from a server channel is recorded, not even a well-formed envelope", () => {
  assert.deepEqual(recoverableMessages("text", [{ id: "1", content: SIG2 }]), []);
});
