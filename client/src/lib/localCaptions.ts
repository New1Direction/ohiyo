import assets from "./localCaptionAssets.json";

export { assets as LOCAL_CAPTION_ASSETS };
export type CaptionStatus = "idle" | "downloading" | "ready" | "starting" | "listening" | "error";
export type CaptionState = {
  status: CaptionStatus; text: string; error: string; bytes: number;
  downloadMs: number | null; loadMs: number | null; firstTextMs: number | null;
  inferenceMs: number; audioSeconds: number; droppedSeconds: number;
};
export const CAPTION_DOWNLOAD_BYTES = [...assets.models, ...assets.runtime].reduce((n, row) => n + Number(row[1]), 0);
const initial = (): CaptionState => ({ status: "idle", text: "", error: "", bytes: 0,
  downloadMs: null, loadMs: null, firstTextMs: null, inferenceMs: 0, audioSeconds: 0, droppedSeconds: 0 });

export interface CaptionWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
export type Capture = { close: () => void };
export type CaptionDependencies = {
  supported: () => string | null;
  fetchAsset: (path: string, size: number, hash: string, signal: AbortSignal) => Promise<Uint8Array>;
  worker: () => CaptionWorker;
  capture: (onAudio: (audio: Float32Array, sampleRate: number) => void, signal: AbortSignal, onEnded: () => void) => Promise<Capture>;
  now: () => number;
};

export function captionUnsupported(): string | null {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "A secure browser with microphone access is required.";
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return "This host needs cross-origin isolation for local captions. See the local-captions setup guide.";
  if (typeof Worker === "undefined" || typeof AudioWorkletNode === "undefined" || typeof WebAssembly === "undefined" || !globalThis.crypto?.subtle) return "This browser does not support the local caption worker and audio runtime.";
  return null;
}

/** Size-limited, same-origin, no-persistence fetch. All pins are locally derived; see docs. */
export async function fetchCaptionAsset(path: string, size: number, hash: string, signal: AbortSignal): Promise<Uint8Array> {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) throw new Error("Asset origin mismatch");
  const response = await fetch(url, { signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok || !response.body) throw new Error("Asset unavailable");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw new Error("Asset size mismatch");
      bytes.set(value, offset); offset += value.length;
    }
    if (offset !== size) throw new Error("Asset size mismatch");
  } finally { await reader.cancel().catch(() => {}); }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== hash || signal.aborted) throw new Error("Asset integrity mismatch");
  return bytes;
}

export async function captureCaptionMicrophone(onAudio: (audio: Float32Array, rate: number) => void, signal: AbortSignal, onEnded: () => void): Promise<Capture> {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  const close = () => {
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); }
    source?.disconnect(); gain?.disconnect();
    stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
    stream = null; context = null; node = null; source = null; gain = null;
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (signal.aborted) { close(); throw new Error("Cancelled"); }
    stream.getAudioTracks().forEach((track) => { track.onended = onEnded; });
    context = new AudioContext();
    const ctx = context;
    await ctx.audioWorklet.addModule(`${assets.base}capture.js`);
    if (signal.aborted) throw new Error("Cancelled");
    node = new AudioWorkletNode(ctx, "local-caption-capture", { channelCount: 1 });
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => { if (!signal.aborted) onAudio(data, ctx.sampleRate); };
    source = ctx.createMediaStreamSource(stream!);
    gain = ctx.createGain(); gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(ctx.destination);
    await ctx.resume();
    if (signal.aborted) throw new Error("Cancelled");
    ctx.onstatechange = () => { if (ctx.state !== "running" && !signal.aborted) onEnded(); };
    return { close };
  } catch (error) { close(); throw error; }
}

const browserDependencies: CaptionDependencies = {
  supported: captionUnsupported, fetchAsset: fetchCaptionAsset,
  worker: () => new Worker(`${assets.base}worker.mjs`, { type: "module", name: "ohiyo-local-captions" }),
  capture: captureCaptionMicrophone, now: () => performance.now(),
};

/** One ephemeral session. No network is reachable from audio/text handling. */
export class LocalCaptionSession {
  state = initial();
  private generation = 0;
  private abort: AbortController | null = null;
  private files: Record<string, Uint8Array> | null = null;
  private wasm: Uint8Array | null = null;
  private worker: CaptionWorker | null = null;
  private capture: Capture | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private micStarted = 0;
  private blocked = false;
  private disposed = false;
  constructor(private changed: (state: CaptionState) => void, private claim: () => boolean, private release: () => void, private deps = browserDependencies) {}
  private publish(patch: Partial<CaptionState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  setBlocked(blocked: boolean) { this.blocked = blocked; if (blocked) this.stop(); }
  private valid(generation: number) { return !this.disposed && generation === this.generation; }
  private fail() {
    this.stop();
    this.publish({ status: "error", error: "Local captions stopped. Check microphone permission, staged assets and worker security headers, then try again. No cloud fallback was used." });
  }
  async download() {
    if (this.disposed || this.blocked || ["downloading", "starting", "listening"].includes(this.state.status)) return;
    const unsupported = this.deps.supported();
    if (unsupported) { this.publish({ status: "error", error: unsupported }); return; }
    this.clearModels();
    const generation = this.generation;
    const abort = this.abort = new AbortController();
    const start = this.deps.now();
    this.publish({ status: "downloading", error: "", bytes: 0 });
    const files: Record<string, Uint8Array> = {};
    let wasm: Uint8Array | null = null;
    try {
      for (const [name, size, hash] of [...assets.runtime, ...assets.models]) {
        const runtime = assets.runtime.some((row) => row[0] === name);
        const bytes = await this.deps.fetchAsset(`${assets.base}${runtime ? "runtime/" : "models/"}${name}`, Number(size), String(hash), abort.signal);
        if (!this.valid(generation)) return;
        if (name === "moonshine.wasm") wasm = bytes;
        else if (!runtime) files[String(name)] = bytes;
        this.publish({ bytes: this.state.bytes + Number(size) });
      }
      if (!this.valid(generation)) return;
      this.files = files; this.wasm = wasm;
      this.publish({ status: "ready", downloadMs: this.deps.now() - start });
    } catch { if (this.valid(generation)) { this.files = null; this.wasm = null; this.fail(); } }
  }
  async start() {
    if (this.disposed || this.blocked || !this.files || !this.wasm || ["downloading", "starting", "listening"].includes(this.state.status)) return;
    const unsupported = this.deps.supported();
    if (unsupported) { this.publish({ status: "error", error: unsupported }); return; }
    if (!this.claim()) return;
    const generation = ++this.generation;
    const abort = this.abort = new AbortController();
    this.inflight = 0;
    this.publish({ status: "starting", text: "", error: "", loadMs: null, firstTextMs: null, inferenceMs: 0, audioSeconds: 0, droppedSeconds: 0 });
    try {
      const worker = this.worker = this.deps.worker();
      worker.onerror = () => { if (this.valid(generation)) this.fail(); };
      worker.onmessage = ({ data }) => {
        if (!this.valid(generation)) return;
        if (data.type === "error") { this.fail(); return; }
        if (data.type === "ready" && this.state.status === "starting") {
          if (this.timeout) clearTimeout(this.timeout);
          this.timeout = null;
          this.publish({ loadMs: data.loadMs });
          void this.deps.capture((audio, rate) => {
            if (!this.valid(generation) || this.state.status !== "listening") return;
            const seconds = audio.length / rate;
            if (this.inflight + seconds > 1) {
              this.publish({ droppedSeconds: this.state.droppedSeconds + seconds });
              if (this.state.droppedSeconds > 2) this.fail();
              return;
            }
            this.inflight += seconds;
            try { worker.postMessage({ type: "audio", audio, sampleRate: rate }, [audio.buffer]); }
            catch { this.fail(); }
          }, abort.signal, () => { if (this.valid(generation)) this.fail(); }).then((capture) => {
            if (!this.valid(generation)) { capture.close(); return; }
            this.capture = capture;
            this.micStarted = this.deps.now();
            this.publish({ status: "listening" });
            this.timeout = setTimeout(() => this.stop(), 180_000);
          }).catch(() => { if (this.valid(generation)) this.fail(); });
        } else if (data.type === "text" && this.state.status === "listening") {
          this.inflight = Math.max(0, this.inflight - Number(data.seconds));
          const text = String(data.text).slice(-4000);
          this.publish({ text, inferenceMs: this.state.inferenceMs + Number(data.ms), audioSeconds: this.state.audioSeconds + Number(data.seconds),
            firstTextMs: this.state.firstTextMs ?? (text.trim() ? this.deps.now() - this.micStarted : null) });
        }
      };
      this.timeout = setTimeout(() => { if (this.valid(generation)) this.fail(); }, 60_000);
      // Copy, not transfer: verified source buffers remain only in this tab's RAM
      // for explicit restarts. Stop kills all inference/audio worker memory.
      worker.postMessage({ type: "load", files: this.files, wasm: this.wasm, identity: assets.models });
    } catch { if (this.valid(generation)) this.fail(); }
  }
  stop() {
    ++this.generation;
    this.abort?.abort(); this.abort = null;
    this.capture?.close(); this.capture = null;
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = null; }
    if (this.timeout) clearTimeout(this.timeout); this.timeout = null;
    this.inflight = 0;
    this.release();
    this.publish({ status: this.files && this.wasm ? "ready" : "idle", text: "", error: "" });
  }
  clearModels() { this.stop(); this.files = null; this.wasm = null; this.publish({ ...initial() }); }
  dispose() { this.clearModels(); this.disposed = true; }
  get hasModels() { return !!this.files && !!this.wasm; }
}
