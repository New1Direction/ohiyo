// When the server refuses this session's token (it expired, or every session was ended
// from another device or by a password change), the gateway says "signed_out" and stops.
// Before, it retried forever and the app showed "Reconnecting you now…" for good.
// Any other failure (network, 5xx) is still "disconnected" and retried.
//   node --experimental-strip-types --test test/gatewaySignedOut.test.ts

import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type GatewayModule = typeof import("../src/gateway.ts");
let bundle: Bundle<GatewayModule>;
let ticketStatus = 200;
let ticketCalls = 0;

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeSocket;
  g.fetch = async () => {
    ticketCalls += 1;
    return ticketStatus === 200
      ? new Response(JSON.stringify({ ticket: "t" }), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("invalid session", { status: ticketStatus });
  };
  bundle = await bundleEntry<GatewayModule>(join(fixtures, "..", "..", "src", "gateway.ts"));
});

after(async () => {
  await bundle?.cleanup();
});

beforeEach(() => {
  ticketCalls = 0;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});

afterEach(() => mock.timers.reset());

async function run(status: number) {
  ticketStatus = status;
  const gateway = new bundle.mod.Gateway("token");
  const statuses: string[] = [];
  gateway.onStatus((s) => statuses.push(s));
  statuses.length = 0; // subscribing reports the status it starts in
  await gateway.connect();
  return { gateway, statuses };
}

test("a refused token stops the gateway as signed out, with no retries", async () => {
  const { gateway, statuses } = await run(401);
  assert.deepEqual(statuses, ["connecting", "signed_out"]);
  mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(ticketCalls, 1);
  gateway.disconnect();
});

for (const status of [500, 503, 429]) {
  test(`a ${status} is a connection problem: disconnected, then retried`, async () => {
    const { gateway, statuses } = await run(status);
    assert.deepEqual(statuses, ["connecting", "disconnected"]);
    mock.timers.tick(2_000);
    await Promise.resolve();
    assert.ok(ticketCalls >= 2, `retried (${ticketCalls} ticket requests)`);
    gateway.disconnect();
  });
}
