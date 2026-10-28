// Explicit local-engine check; does not download anything or print transcripts.
// Optional third argument: little-endian float32 mono PCM at 16 kHz.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import createModule from "@moonshine-ai/moonshine-wasm/moonshine.mjs";
import { Transcriber, ModelArch } from "@moonshine-ai/moonshine-wasm";

if (!process.argv[2]) throw new Error("Usage: node scripts/check-local-captions.mjs <Tiny model directory> [16k-f32le PCM]");
const identity = JSON.parse(await readFile(new URL("../src/lib/localCaptionAssets.json", import.meta.url), "utf8"));
const files = {};
function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  const buffer = Buffer.alloc(4); buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return buffer.toString("base64");
}
for (const [name, size, hash, crc] of identity.models) {
  const bytes = await readFile(join(process.argv[2], name));
  assert.equal(bytes.length, size); assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  assert.equal(crc32c(bytes), crc); files[name] = bytes;
}
Object.defineProperty(navigator, "hardwareConcurrency", { value: 2 });
const began = performance.now();
const wasm = await readFile(new URL("../node_modules/@moonshine-ai/moonshine-wasm/dist/moonshine.wasm", import.meta.url));
assert.equal(createHash("sha256").update(wasm).digest("hex"), identity.runtime[0][2]);
const module = await createModule({ wasmBinary: wasm, print: () => {}, printErr: () => {} });
const manifest = JSON.parse(module.sttDependencies("en", "2", false));
assert.deepEqual(manifest.groups.flatMap((g) => g.files).map((f) => [f.name, f.size, f.checksum]), identity.models.map(([name, size, , crc]) => [name, size, crc]));
const transcriber = await Transcriber.load({ module, files, modelArch: ModelArch.TinyStreaming,
  options: { identify_speakers: "false", word_timestamps: "false" } });
const loadMs = performance.now() - began;
const stream = transcriber.createStream({ updateInterval: 0.5 }); stream.start();
const raw = process.argv[3] ? await readFile(process.argv[3]) : Buffer.alloc(16000 * 4 * 2);
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const started = performance.now(); let text = "";
for (let i = 0; i < audio.length; i += 8000) {
  stream.addAudio(audio.subarray(i, i + 8000), 16000);
  text = stream.transcribe().lines.map((line) => line.text).join(" ");
}
text = stream.transcribe(1).lines.map((line) => line.text).join(" ");
if (process.argv[3]) assert.ok(text.trim(), "Speech control produced no caption");
else assert.ok(!text.trim(), "Silence control hallucinated text");
const processingMs = performance.now() - started;
stream.close(); transcriber.close();
console.log(JSON.stringify({ pinsAndCrcMatch: true, architecture: "TinyStreaming", modelBytes: identity.models.reduce((n, row) => n + row[1], 0),
  control: process.argv[3] ? "nonempty speech caption" : "silence: no caption", loadMs: Math.round(loadMs),
  audioSeconds: audio.length / 16000, processingMs: Math.round(processingMs), accuracy: "not evaluated", browserLatency: "not measured" }));
// Emscripten keeps its pthread pool alive; this explicit CLI check is complete.
process.exit(0);
