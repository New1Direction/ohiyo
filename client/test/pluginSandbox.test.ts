// C-H7: the plugin worker removes every network and messaging API before the plugin's
// code runs. SandboxHost's real worker script runs here in a node vm context shaped like
// a worker's global scope: the APIs live on its prototype, as they do on
// WorkerGlobalScope.prototype, and navigator.sendBeacon on the navigator's prototype.
//   node --experimental-strip-types --test test/pluginSandbox.test.ts

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { SandboxHost } from "../src/plugins/sandbox.ts";

const REMOVED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "RTCPeerConnection",
  "RTCDataChannel",
  "BroadcastChannel",
  "SharedWorker",
  "Worker",
  "importScripts",
  "Request",
  "Response",
  "caches",
  "indexedDB",
  "FontFace",
  "fonts",
];

let script: Blob | null = null;

// Runs the worker script in a vm context instead of a real worker thread.
class VmWorker {
  static last: VmWorker | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  context: vm.Context;
  ran: Promise<void>;
  constructor() {
    VmWorker.last = this;
    const scope = Object.fromEntries(REMOVED.filter((name) => name !== "fonts").map((name) => [name, function original() {}]));
    // Like WorkerGlobalScope.prototype.fonts: a getter for the worker's FontFaceSet.
    Object.defineProperty(scope, "fonts", { get: () => ({ add() {}, load() {} }), configurable: true, enumerable: true });
    const g = Object.create(scope) as Record<string, unknown>;
    g.navigator = Object.create({ sendBeacon: () => true });
    g.postMessage = (data: unknown) => this.onmessage?.({ data });
    g.self = g;
    this.context = vm.createContext(g);
    const source = script;
    if (!source) throw new Error("no worker script");
    this.ran = source.text().then((code) => void vm.runInContext(code, this.context));
  }
  postMessage(data: unknown) {
    (this.context.onmessage as ((e: { data: unknown }) => void) | undefined)?.({ data });
  }
  terminate() {}
}

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

before(() => {
  URL.createObjectURL = (blob: Blob) => {
    script = blob;
    return "blob:plugin";
  };
  URL.revokeObjectURL = () => {};
  (globalThis as Record<string, unknown>).Worker = VmWorker;
  mock.timers.enable({ apis: ["setTimeout"] }); // the host's 5s registration timeout
});

after(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  mock.timers.reset();
});

test("a sandboxed plugin can reach no network or messaging API", async () => {
  const host = new SandboxHost('kikkacord.definePlugin({ id: "probe", name: "Probe" });', {
    onToast() {},
    onError() {},
  });
  await VmWorker.last!.ran;
  assert.equal((await host.ready()).id, "probe");
  const ctx = VmWorker.last!.context;
  for (const name of REMOVED) {
    assert.equal(vm.runInContext(`typeof ${name}`, ctx), "undefined", `${name} is still reachable`);
    assert.equal(
      vm.runInContext(`typeof Object.getPrototypeOf(self)[${JSON.stringify(name)}]`, ctx),
      "undefined",
      `${name} is still reachable through the prototype`,
    );
  }
  assert.equal(vm.runInContext("typeof navigator.sendBeacon", ctx), "undefined");
});
