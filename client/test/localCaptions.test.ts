import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";
import type { CaptionDependencies, CaptionWorker, Capture } from "../src/lib/localCaptions.ts";

type Runtime = typeof import("../src/lib/localCaptions.ts");
let bundle: Bundle<Runtime>;
before(async () => { bundle = await bundleEntry<Runtime>(join(fixtures, "localCaptionRuntime.ts")); });
after(async () => { await bundle?.cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 4; i++) await Promise.resolve(); }
function harness() {
  const workers: (CaptionWorker & { sent: unknown[]; stopped: number })[] = [];
  let fetched = 0, captures = 0, closed = 0, releases = 0, claims = 0, time = 100;
  let unsupported: string | null = null;
  let allowed = true;
  let audio: ((audio: Float32Array, rate: number) => void) | null = null;
  let ended: (() => void) | null = null;
  const signals: AbortSignal[] = [];
  let getCapture = async (): Promise<Capture> => ({ close: () => { closed++; } });
  let fetchAsset: CaptionDependencies["fetchAsset"] = async (_path, _size, _hash, signal) => {
    signals.push(signal); fetched++; return new Uint8Array([1]);
  };
  const deps: CaptionDependencies = {
    supported: () => unsupported,
    fetchAsset: (...args) => fetchAsset(...args),
    capture: (onAudio, signal, onEnded) => { captures++; audio = onAudio; ended = onEnded; signals.push(signal); return getCapture(); },
    worker: () => {
      const worker = { sent: [] as unknown[], stopped: 0, onmessage: null, onerror: null,
        postMessage(message: unknown) { this.sent.push(message); }, terminate() { this.stopped++; } };
      workers.push(worker); return worker;
    }, now: () => time,
  };
  const session = new bundle.mod.LocalCaptionSession(() => {}, () => { claims++; return allowed; }, () => { releases++; }, deps);
  const emit = (data: unknown, index = workers.length - 1) => workers[index].onmessage?.({ data } as MessageEvent);
  return { session, workers, signals, emit,
    stats: () => ({ fetched, captures, closed, releases, claims }),
    unsupported: (reason: string | null) => { unsupported = reason; }, allow: (value: boolean) => { allowed = value; },
    fetch: (fn: typeof fetchAsset) => { fetchAsset = fn; }, capture: (fn: typeof getCapture) => { getCapture = fn; },
    time: (value: number) => { time = value; },
    audio: (samples = 8000, rate = 16000) => audio?.(new Float32Array(samples), rate),
    ended: () => ended?.(),
  };
}

test("constructor and Start before Download perform zero network, runtime or mic work", async () => {
  const h = harness();
  await h.session.start();
  assert.equal(h.stats().fetched, 0); assert.equal(h.workers.length, 0); assert.equal(h.stats().captures, 0);
  h.session.dispose();
});

test("Download verifies only pinned runtime + seven Tiny files, never creates worker or mic", async () => {
  const h = harness();
  const paths: string[] = [];
  h.fetch(async (path, size, hash) => { paths.push(path); assert.ok(size > 0); assert.match(hash, /^[0-9a-f]{64}$/); return new Uint8Array([1]); });
  await h.session.download();
  assert.equal(paths.length, 17);
  assert.ok(paths.every((path) => path.startsWith(bundle.mod.LOCAL_CAPTION_ASSETS.base)));
  assert.ok(paths.every((path) => !/medium|spelling|embedding|attention/.test(path)));
  assert.equal(h.session.state.bytes, bundle.mod.CAPTION_DOWNLOAD_BYTES);
  assert.equal(h.session.state.status, "ready");
  assert.equal(h.workers.length, 0); assert.equal(h.stats().captures, 0);
  h.session.dispose();
});

test("unsupported host or active call refuses Download without any fetch", async () => {
  const h = harness(); h.unsupported("Isolation required");
  await h.session.download(); assert.equal(h.session.state.error, "Isolation required");
  h.unsupported(null); h.session.setBlocked(true);
  await h.session.download(); await h.session.start();
  assert.equal(h.stats().fetched, 0); assert.equal(h.stats().captures, 0);
  h.session.dispose();
});

test("cancel/clear during a pending download invalidates late success; duplicate Download is ignored", async () => {
  const h = harness(), pending = deferred<Uint8Array>();
  let attempts = 0;
  h.fetch(async (_p, _s, _h, signal) => { attempts++; h.signals.push(signal); return pending.promise; });
  const first = h.session.download(); await h.session.download();
  h.session.clearModels();
  assert.equal(h.signals[0].aborted, true);
  pending.resolve(new Uint8Array([1])); await first;
  assert.equal(attempts, 1); assert.equal(h.session.hasModels, false); assert.equal(h.session.state.status, "idle");
  h.session.dispose();
});

test("failed integrity/download never enables Start or invokes fallback", async () => {
  const h = harness(); h.fetch(async () => { throw new Error("private source details"); });
  await h.session.download(); await h.session.start();
  assert.equal(h.session.state.status, "error"); assert.doesNotMatch(h.session.state.error, /private source/);
  assert.equal(h.session.hasModels, false); assert.equal(h.stats().captures, 0); assert.equal(h.workers.length, 0);
  h.session.dispose();
});

test("Start is explicit, claims exclusive capture, and waits for worker readiness before mic", async () => {
  const h = harness(); await h.session.download();
  h.allow(false); await h.session.start(); assert.equal(h.workers.length, 0);
  h.allow(true); await h.session.start(); await h.session.start();
  assert.equal(h.workers.length, 1); assert.equal(h.stats().captures, 0);
  const load = h.workers[0].sent[0] as { type: string; identity: unknown[]; files: Record<string, Uint8Array> };
  assert.equal(load.type, "load"); assert.deepEqual(load.identity, bundle.mod.LOCAL_CAPTION_ASSETS.models);
  assert.equal(Object.keys(load.files).length, 7);
  h.emit({ type: "ready", loadMs: 32 }); await settle();
  assert.equal(h.stats().captures, 1); assert.equal(h.session.state.status, "listening");
  h.session.dispose(); assert.equal(h.stats().closed, 1); assert.equal(h.workers[0].stopped, 1);
});

test("late worker callbacks after Stop cannot request mic or populate text", async () => {
  const h = harness(); await h.session.download(); await h.session.start();
  const stale = h.workers[0].onmessage;
  h.session.stop();
  stale?.({ data: { type: "ready", loadMs: 1 } } as MessageEvent);
  stale?.({ data: { type: "text", text: "must not survive" } } as MessageEvent);
  assert.equal(h.stats().captures, 0); assert.equal(h.session.state.text, "");
  assert.equal(h.session.state.status, "ready"); h.session.dispose();
});

test("Stop while permission is pending aborts and closes late capture without reviving session", async () => {
  const h = harness(), pending = deferred<Capture>(); let lateClosed = 0;
  h.capture(() => pending.promise);
  await h.session.download(); await h.session.start(); h.emit({ type: "ready", loadMs: 1 });
  h.session.stop(); assert.ok(h.signals.at(-1)?.aborted);
  pending.resolve({ close: () => { lateClosed++; } }); await settle();
  assert.equal(lateClosed, 1); assert.equal(h.session.state.status, "ready");
  h.session.dispose();
});

test("call-start, mic ended, worker error and Clear all stop capture and erase text", async () => {
  for (const interruption of ["call", "ended", "worker", "clear"] as const) {
    const h = harness(); await h.session.download(); await h.session.start(); h.emit({ type: "ready", loadMs: 1 }); await settle();
    h.audio(); h.time(250); h.emit({ type: "text", text: "temporary", ms: 10, seconds: 0.5 });
    assert.equal(h.session.state.firstTextMs, 150);
    if (interruption === "call") h.session.setBlocked(true);
    if (interruption === "ended") h.ended();
    if (interruption === "worker") h.emit({ type: "error" });
    if (interruption === "clear") h.session.clearModels();
    assert.equal(h.session.state.text, ""); assert.equal(h.stats().closed, 1); assert.equal(h.workers[0].stopped, 1);
    h.session.setBlocked(false); assert.equal(h.stats().captures, 1, "unblocking must not resume capture");
    h.session.dispose();
  }
});

test("visible text and audio backlog are bounded; overload stops rather than growing indefinitely", async () => {
  const h = harness(); await h.session.download(); await h.session.start(); h.emit({ type: "ready", loadMs: 1 }); await settle();
  h.emit({ type: "text", text: "x".repeat(8000), ms: 10, seconds: 0 });
  assert.equal(h.session.state.text.length, 4000);
  for (let i = 0; i < 8; i++) h.audio();
  assert.equal(h.session.state.status, "error"); assert.equal(h.session.state.text, "");
  assert.equal(h.stats().closed, 1); assert.ok(h.session.state.droppedSeconds > 2);
  h.session.dispose();
});

test("real asset fetch enforces same-origin, exact length and SHA-256, with no cache or credentials", async () => {
  const previousFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: { href: "https://ohiyo.test/", origin: "https://ohiyo.test" }, configurable: true });
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++; assert.equal(options?.cache, "no-store"); assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error"); assert.equal(options?.referrerPolicy, "no-referrer");
    return new Response(bytes);
  };
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await bundle.mod.fetchCaptionAsset("/model", 3, hash, signal), bytes);
    await assert.rejects(bundle.mod.fetchCaptionAsset("/model", 2, hash, signal));
    await assert.rejects(bundle.mod.fetchCaptionAsset("/model", 4, hash, signal));
    await assert.rejects(bundle.mod.fetchCaptionAsset("/model", 3, "0".repeat(64), signal));
    await assert.rejects(bundle.mod.fetchCaptionAsset("https://cloud.test/model", 3, hash, signal));
    assert.equal(requests, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor); else Reflect.deleteProperty(globalThis, "location");
  }
});

test("real capture adapter stops a late microphone grant after cancellation without creating AudioContext", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const pending = deferred<unknown>(); let stopped = 0;
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: () => pending.promise } }, configurable: true });
  try {
    const abort = new AbortController();
    const capture = bundle.mod.captureCaptionMicrophone(() => {}, abort.signal, () => {});
    abort.abort();
    pending.resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
    await assert.rejects(capture);
    assert.equal(stopped, 1);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("real capture adapter releases tracks/context while worklet loading is pending", async () => {
  const originals = new Map(["navigator", "AudioContext"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const loading = deferred<void>(); let stopped = 0, closed = 0;
  const track = { onended: null, stop: () => { stopped++; } };
  class Context {
    audioWorklet = { addModule: () => loading.promise };
    onstatechange = null;
    async close() { closed++; }
  }
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } }, configurable: true });
  Object.defineProperty(globalThis, "AudioContext", { value: Context, configurable: true });
  try {
    const abort = new AbortController();
    const capture = bundle.mod.captureCaptionMicrophone(() => {}, abort.signal, () => {});
    await settle(); abort.abort();
    assert.equal(stopped, 1); assert.equal(closed, 1);
    loading.resolve(); await assert.rejects(capture);
    assert.equal(stopped, 1); assert.equal(closed, 1);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("startup timeout and three-minute listening cap terminate the worker and clear captions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const loading = harness(); await loading.session.download(); await loading.session.start();
  t.mock.timers.tick(60_000);
  assert.equal(loading.session.state.status, "error"); assert.equal(loading.workers[0].stopped, 1);
  loading.session.dispose();
  const listening = harness(); await listening.session.download(); await listening.session.start();
  listening.emit({ type: "ready", loadMs: 1 }); await settle();
  listening.emit({ type: "text", text: "temporary", ms: 1, seconds: 0 });
  t.mock.timers.tick(180_000);
  assert.equal(listening.session.state.status, "ready"); assert.equal(listening.session.state.text, "");
  assert.equal(listening.stats().closed, 1); assert.equal(listening.workers[0].stopped, 1);
  listening.session.dispose();
});
