// Uploading an avatar, banner, space logo or emoji: a refusal shows the server's own
// sentence (a full disk, the account's upload limit), never a JSON parse error.
//   node --experimental-strip-types --test test/uploadOne.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadOne } from "../src/lib/uploadOne.ts";

const answering = (body: string, status: number) => async () => new Response(body, { status });

test("a full disk shows the server's sentence", async () => {
  const sentence = "Ohiyo is short on storage right now. Try again later.";
  await assert.rejects(uploadOne("https://ohiyo.test/api/v1", "t", new Blob(["hi"]), answering(sentence, 507)), (err: Error & { status?: number }) => {
    assert.equal(err.message, sentence);
    assert.equal(err.status, 507);
    return true;
  });
});

test("the upload limit shows the server's sentence", async () => {
  await assert.rejects(
    uploadOne("https://ohiyo.test/api/v1", "t", new Blob(["hi"]), answering("upload quota exceeded", 413)),
    { message: "upload quota exceeded" },
  );
});

test("a refusal with nothing to say still says the upload failed", async () => {
  await assert.rejects(uploadOne("https://ohiyo.test/api/v1", "t", new Blob(["hi"]), answering("", 502)), {
    message: "Upload failed (HTTP 502)",
  });
});

test("a stored file comes back with its id, sent with the account's token", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("Authorization") };
    return new Response(JSON.stringify([{ id: "f1", url: "/files/f1" }]), { status: 200 });
  }) as typeof fetch;

  const uploaded = await uploadOne("https://ohiyo.test/api/v1", "tok", new Blob(["hi"]), fetchImpl);

  assert.deepEqual(uploaded, { id: "f1", url: "/files/f1" });
  assert.deepEqual(seen, { url: "https://ohiyo.test/api/v1/upload", auth: "Bearer tok" });
});
