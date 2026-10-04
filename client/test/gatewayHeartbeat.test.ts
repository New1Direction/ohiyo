// M8: the server answers each Heartbeat with {"t":"HeartbeatAck"} so a quiet socket isn't
// treated as dead. The client knows the tag, so the ack produces no "unknown tag" warning;
// any inbound frame already counts as alive. gateway.ts is bundled and driven with a stub
// WebSocket and a stub fetch (no network).
//   node --experimental-strip-types --test test/gatewayHeartbeat.test.ts

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type GatewayModule = typeof import("../src/gateway.ts");
let bundle: Bundle<GatewayModule>;

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeSocket;
  g.fetch = async () => new Response(JSON.stringify({ ticket: "t" }), { status: 200, headers: { "Content-Type": "application/json" } });
  bundle = await bundleEntry<GatewayModule>(join(fixtures, "..", "..", "src", "gateway.ts"));
});

after(async () => {
  await bundle?.cleanup();
});

async function connected() {
  const gateway = new bundle.mod.Gateway("token");
  const seen: string[] = [];
  gateway.on((event) => seen.push(event.t));
  await gateway.connect();
  return { socket: FakeSocket.last!, seen };
}

test("a HeartbeatAck produces no warning", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const { socket } = await connected();
    socket.onmessage!({ data: JSON.stringify({ t: "HeartbeatAck" }) });
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    warn.mock.restore();
  }
});

test("a frame with a tag the client doesn't know still warns", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const { socket, seen } = await connected();
    socket.onmessage!({ data: JSON.stringify({ t: "SomethingNew" }) });
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(seen, []);
  } finally {
    warn.mock.restore();
  }
});
