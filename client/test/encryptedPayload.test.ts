// Tests for encrypted-attachment manifests. The manifest arrives inside an E2E message,
// so its URL is sender-controlled: only a /files/<id> path on the current home may be
// fetched (anything else would be a zero-click request to any host), and the decrypted
// Blob's type comes from an allowlist (an attacker-chosen type such as image/svg+xml or
// text/html would run script when the blob URL is opened).
//   node --experimental-strip-types --test test/encryptedPayload.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  homeFileUrl,
  packEncryptedMessagePlaintext,
  safeAttachmentBlobType,
  unpackEncryptedMessagePlaintext,
  type EncryptedAttachmentMeta,
} from "../src/lib/encryptedPayload.ts";

const HOME = "https://home.example";
const ID = "11111111-2222-3333-4444-555555555555";

const att = (url: string | undefined, id = ID): EncryptedAttachmentMeta => ({
  id,
  url,
  filename: "photo.png",
  content_type: "image/png",
  size_bytes: 10,
  encrypted: { alg: "AES-256-GCM", key: "k", iv: "i", cipher_size_bytes: 26 },
});

const roundTrip = (url: string | undefined, id = ID) =>
  unpackEncryptedMessagePlaintext(packEncryptedMessagePlaintext("hi", [att(url, id)]), HOME).attachments ?? [];

test("an attachment on this home's /files/<id> path is kept", () => {
  assert.equal(roundTrip(`/files/${ID}?s=0123abcd`).length, 1, "signed relative path");
  assert.equal(roundTrip(`/files/${ID}`).length, 1, "unsigned relative path");
  assert.equal(roundTrip(`${HOME}/files/${ID}?s=0123abcd`).length, 1, "absolute on the current home");
  assert.equal(roundTrip(undefined).length, 1, "no url: falls back to /files/<id>");
});

test("an attachment pointing anywhere else is dropped", () => {
  const bad = [
    `https://evil.example/files/${ID}`,
    `//evil.example/files/${ID}`,
    `/\\evil.example/files/${ID}`,
    `http://home.example/files/${ID}`, // wrong scheme for this home
    `https://home.example:8443/files/${ID}`,
    `https://user:pw@home.example/files/${ID}`,
    `/files/22222222-2222-3333-4444-555555555555`, // someone else's file id
    `/avatars/${ID}`,
    `/files/${ID}/../../api/v1/users/@me`,
    `javascript:alert(1)`,
    `data:image/png;base64,AAAA`,
    `blob:${HOME}/files/${ID}`,
  ];
  for (const url of bad) assert.equal(roundTrip(url).length, 0, url);
  assert.equal(roundTrip(undefined, "../../evil").length, 0, "an id that isn't a plain token");
});

test("homeFileUrl gives the absolute URL to fetch, or null", () => {
  assert.equal(homeFileUrl(att(`/files/${ID}?s=ab`), HOME), `${HOME}/files/${ID}?s=ab`);
  assert.equal(homeFileUrl(att(undefined), HOME), `${HOME}/files/${ID}`);
  assert.equal(homeFileUrl(att(`https://evil.example/files/${ID}`), HOME), null);
});

test("the decrypted Blob type comes from an allowlist; anything else is octet-stream", () => {
  for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "application/pdf", "text/plain"]) {
    assert.equal(safeAttachmentBlobType(ok), ok);
  }
  assert.equal(safeAttachmentBlobType("IMAGE/PNG"), "image/png");
  assert.equal(safeAttachmentBlobType("text/plain; charset=utf-8"), "text/plain");
  for (const bad of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/javascript", "text/xml", "application/octet-stream", "", "nonsense"]) {
    assert.equal(safeAttachmentBlobType(bad), "application/octet-stream", bad);
  }
});
