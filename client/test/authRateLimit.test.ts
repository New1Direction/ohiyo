// Register and login can answer 429 (registration is limited to 10 per hour per network
// address). The sign-in screen shows a clear message for it, not a generic failure. api.ts
// is bundled and its requests answered by a stub fetch (no network).
//   node --experimental-strip-types --test test/authRateLimit.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { rateLimitMessage } from "../src/lib/apiErrors.ts";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Api = typeof import("../src/api.ts");
let bundle: Bundle<Api>;
let answer: Response;

before(async () => {
  (globalThis as Record<string, unknown>).fetch = async () => answer;
  bundle = await bundleEntry<Api>(join(fixtures, "..", "..", "src", "api.ts"));
});

after(async () => {
  await bundle?.cleanup();
});

const TOO_MANY = "Too many attempts. Try again in a few minutes.";

test("a rate-limited registration shows the too-many-attempts message", async () => {
  answer = new Response("too many new accounts from your network — try again later", { status: 429 });
  await assert.rejects(bundle.mod.api.register("newbie", "correct horse battery"), (err: unknown) => rateLimitMessage(err) === TOO_MANY);
});

test("a rate-limited login shows the too-many-attempts message", async () => {
  answer = new Response("too many attempts — give it a moment and try again", { status: 429 });
  await assert.rejects(bundle.mod.api.login("someone", "wrong password"), (err: unknown) => rateLimitMessage(err) === TOO_MANY);
});

test("other failures keep their own handling and message", async () => {
  answer = new Response("invalid credentials", { status: 401 });
  await assert.rejects(bundle.mod.api.login("someone", "wrong password"), (err: unknown) => {
    return rateLimitMessage(err) === null && err instanceof Error && err.message === "invalid credentials";
  });
});
