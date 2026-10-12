// "Add an Ohiyo home" took an invite code as a server address: `daa596fqrut8` became a home at
// https://daa596fqrut8, the app switched to it and every request failed. An invite or private
// DM link now opens on the current home, a home must look like a host, and it must answer as an
// Ohiyo server before it is added.
//   node --experimental-strip-types --test test/homeInput.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOhiyoHome, readHomeInput } from "../src/lib/homeInput.ts";

test("an invite code or link, or a private DM link, is opened, not added as a home", () => {
  assert.deepEqual(readHomeInput("daa596fqrut8"), { kind: "link", link: { kind: "invite", code: "daa596fqrut8" } });
  assert.deepEqual(readHomeInput("https://app.ohiyo.gg/?invite=daa596fqrut8"), { kind: "link", link: { kind: "invite", code: "daa596fqrut8" } });
  assert.deepEqual(readHomeInput("ohiyo://invite/daa596fqrut8"), { kind: "link", link: { kind: "invite", code: "daa596fqrut8" } });
  assert.deepEqual(readHomeInput("https://app.ohiyo.gg/dm/tok_abc123"), { kind: "link", link: { kind: "dm", token: "tok_abc123" } });
});

test("a home address becomes the server's origin", () => {
  assert.deepEqual(readHomeInput("https://my-ohiyo.example/some/page"), { kind: "home", url: "https://my-ohiyo.example" });
  assert.deepEqual(readHomeInput("  my-ohiyo.example "), { kind: "home", url: "https://my-ohiyo.example" });
  assert.deepEqual(readHomeInput("http://localhost:3000"), { kind: "home", url: "http://localhost:3000" });
  assert.deepEqual(readHomeInput("http://abcdefghijklmnop.onion"), { kind: "home", url: "http://abcdefghijklmnop.onion" });
});

test("something that can't be a server address is refused", () => {
  for (const raw of ["", "   ", "https://daa596fqrut8", "not a url!", "ftp://my-ohiyo.example", "https://"]) {
    assert.deepEqual(readHomeInput(raw), { kind: "invalid" }, `refused: ${JSON.stringify(raw)}`);
  }
});

function answering(body: string, status = 200): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fake = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetch: fake, asked };
}

test("a home is added only when it answers like an Ohiyo server", async () => {
  const ok = answering("ok\n");
  assert.equal(await isOhiyoHome("https://my-ohiyo.example", ok.fetch), true);
  assert.deepEqual(ok.asked, ["https://my-ohiyo.example/healthz"]);
  assert.equal(await isOhiyoHome("https://my-ohiyo.example", answering("<html>a shop</html>").fetch), false);
  assert.equal(await isOhiyoHome("https://my-ohiyo.example", answering("not found", 404).fetch), false);
  const unreachable = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.equal(await isOhiyoHome("https://nothing-here.invalid", unreachable), false);
});

test("a home that never answers is given up on", async () => {
  const silent = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  assert.equal(await isOhiyoHome("https://slow.example", silent, 30), false);
});
