// A file attached while a chat was unencrypted was uploaded in the clear. Once the chat is
// in encrypted mode, such a file must never go out with a message: the composer drops it
// (with a toast), and every send path (send, retry, outbox flush) refuses a message that
// still carries one. Forward into an encrypted chat is refused outright (encryptedSend
// forwardBlockReason). Before this, a message with only such files and no text skipped
// encryption entirely and went out with the files attached in the clear.
//   node --experimental-strip-types --test test/encryptedAttachments.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { EncryptedSendError, outgoingWire, pendingAttachmentsToKeep } from "../src/lib/encryptedSend.ts";

const REATTACH = "Re-attach files to send them encrypted.";
const sealed = { id: "f-enc", encrypted: { key: "k" } };

function encryptor() {
  const calls = { n: 0 };
  return { calls, encrypt: async () => (calls.n++, "sig2.ciphertext") };
}

const refused = (err: unknown) =>
  err instanceof EncryptedSendError && err.reason === "unencrypted-attachment" && err.message === REATTACH;

test("encrypted mode refuses a message whose only attachment was uploaded in the clear", async () => {
  const { calls, encrypt } = encryptor();
  await assert.rejects(outgoingWire({ content: "", attachmentIds: ["f-plain"] }, true, encrypt), refused);
  assert.equal(calls.n, 0);
});

test("encrypted mode refuses text with a mix of encrypted and plain attachments", async () => {
  const { encrypt } = encryptor();
  const message = { content: "see attached", attachmentIds: ["f-enc", "f-plain"], encryptedAttachments: [sealed] };
  await assert.rejects(outgoingWire(message, true, encrypt), refused);
});

test("encrypted mode sends ciphertext when every attachment is encrypted", async () => {
  const { calls, encrypt } = encryptor();
  const wire = await outgoingWire({ content: "", attachmentIds: ["f-enc"], encryptedAttachments: [sealed] }, true, encrypt);
  assert.equal(wire, "sig2.ciphertext");
  assert.equal(calls.n, 1);
});

test("outside encrypted mode the text goes as it is", async () => {
  const { calls, encrypt } = encryptor();
  assert.equal(await outgoingWire({ content: "hi", attachmentIds: ["f-plain"] }, false, encrypt), "hi");
  assert.equal(calls.n, 0);
});

test("entering encrypted mode drops pending attachments that weren't uploaded encrypted", () => {
  const plain = { id: "f-plain" };
  assert.deepEqual(pendingAttachmentsToKeep([plain, sealed], true), [sealed]);
});

test("nothing changes when every pending attachment is encrypted, or the chat isn't encrypted", () => {
  const all = [sealed];
  assert.equal(pendingAttachmentsToKeep(all, true), all);
  const mixed = [{ id: "f-plain" }, sealed];
  assert.equal(pendingAttachmentsToKeep(mixed, false), mixed);
});
