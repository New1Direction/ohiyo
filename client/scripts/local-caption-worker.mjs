// Served only from the explicitly staged, versioned same-origin asset directory.
import createModule from "./runtime/moonshine.mjs";
import { Transcriber } from "./runtime/transcriber.js";
import { ModelArch } from "./runtime/enums.js";

let stream;
let transcriber;
// Bound the Emscripten pthread pool rather than spawning one per logical CPU.
Object.defineProperty(navigator, "hardwareConcurrency", { value: 2 });
// No catalog, model fetch, caching, logs, spelling or diarization in this worker.
globalThis.fetch = () => Promise.reject(new Error("Network disabled"));
globalThis.XMLHttpRequest = class { constructor() { throw new Error("Network disabled"); } };

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      const started = performance.now();
      const module = await createModule({
        wasmBinary: data.wasm,
        mainScriptUrlOrBlob: new URL("./runtime/moonshine.mjs", import.meta.url).href,
        locateFile: (name) => {
          if (name !== "moonshine.mjs" && name !== "moonshine.wasm") throw new Error("Unexpected runtime fetch");
          return new URL(`./runtime/${name}`, import.meta.url).href;
        },
        print: () => {}, printErr: () => {},
      });
      // Validate the binary's own catalog against the reviewed exact files.
      const manifest = JSON.parse(module.sttDependencies("en", "2", false));
      const entries = manifest.groups.flatMap((g) => g.files);
      if (entries.length !== data.identity.length || entries.some((f, i) => {
        const [name, size, , crc] = data.identity[i];
        return f.name !== name || f.size !== size || f.checksum !== crc || f.checksum_type !== "crc32c"
          || f.url !== `https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_07_30/${name}`;
      })) throw new Error("Runtime/model catalog mismatch");
      transcriber = await Transcriber.load({
        module, files: data.files, modelArch: ModelArch.TinyStreaming,
        options: { identify_speakers: "false", word_timestamps: "false" },
      });
      stream = transcriber.createStream({ updateInterval: 0.5 });
      stream.start();
      self.postMessage({ type: "ready", loadMs: performance.now() - started });
    } else if (data.type === "audio" && stream) {
      const started = performance.now();
      stream.addAudio(data.audio, data.sampleRate);
      const transcript = stream.transcribe();
      // Both engine session duration and visible text are independently bounded.
      const text = transcript.lines.slice(-20).map((line) => line.text).join("\n").slice(-4000);
      self.postMessage({ type: "text", text, ms: performance.now() - started, seconds: data.audio.length / data.sampleRate });
    }
  } catch {
    // Never return native error strings: they may contain text or model internals.
    self.postMessage({ type: "error" });
  }
};
