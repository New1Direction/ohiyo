# English local-microphone caption pilot

Settings → Voice & video has an experimental **English Tiny Streaming** preview.
It is not call captions. There is no received-audio integration, diarization,
spelling model, cloud fallback, transcript persistence or transcript telemetry.
Do not expand it to received audio before measuring performance and accuracy.

## Explicit setup and consent

Operators stage assets; opening Settings never fetches a model or runtime.
From `client/`, after installing dependencies with scripts disabled:

```sh
bun install --ignore-scripts
node scripts/stage-local-captions.mjs
# Or reuse an already downloaded Tiny directory (same exact checks):
node scripts/stage-local-captions.mjs /tmp/tiny-en
VITE_LOCAL_CAPTION_ISOLATION=1 bun run dev
```

The staging script reads the **pinned** npm package, verifies every runtime file,
downloads only the seven reviewed Tiny English files, checks their lengths and
locally derived SHA-256 digests, and copies model/runtime notices from a pinned
upstream source revision. It does not start a mic or run inference. It is never
run by install, build or app startup. Output under `client/public/local-captions/`
is gitignored and is copied into a subsequent Vite build. Review deployment
contents and notices before distributing. Re-run staging after worker changes.

Browser consent is separate: **Download model & runtime** retrieves ~64.8 MB
uncompressed from this host, verifies it, and retains model buffers in tab RAM.
No worker, WASM compilation or mic starts during Download. **Start preview** then
creates the worker, loads verified model buffers and requests the mic. The
runtime JS is fetched again as module imports under the host's `no-store`
policy; numbers exclude this small second transfer, worker/worklet and notices.

**Stop & clear text** terminates the worker, stops tracks/context, discards audio
and text, and retains verified source buffers for explicit restarts.
**Clear models & text** additionally drops those buffers and aborts downloads.
Leaving Voice settings, closing Settings or `pagehide` clears everything.
Errors stop capture and erase text. Generations invalidate stale permission,
download and worker callbacks. JS/WASM memory is released for GC, not securely
zeroized. Visible text is bounded to 20 recent lines / 4,000 characters. Sessions
stop after three minutes; audio backlog is capped at one second, with dropped
audio counted and sustained overload (>2 seconds dropped) stopping the pilot.

`VoiceTab({ voiceActive = false })` must receive true during **both channel and
DM calls**, even when muted/deafened. Calls refuse/cancel the separate caption
capture and meter, without automatically restarting when the call ends. A
synchronous shared guard makes the meter and caption capture mutually exclusive.

## Host security requirements

Published 0.1.5 is SIMD + pthread WASM: it needs SharedArrayBuffer and a secure,
cross-origin-isolated browser. Unsupported hosts fail before downloading.
Vite dev/preview enables isolation **only** with
`VITE_LOCAL_CAPTION_ISOLATION=1`. Production hosts must independently provide:

```text
# Document/resources for an explicitly opted-in pilot host:
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp

# /local-captions/* responses, particularly worker.mjs and runtime/moonshine.mjs:
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'none'
Cache-Control: no-store
Cross-Origin-Resource-Policy: same-origin
```

Serve `.js`/`.mjs` with a JavaScript MIME type, WASM as `application/wasm`, and
model files as binary. Do not SPA-fallback missing assets to index.html.
Production verification must use real response headers, not merely a meta tag.
The main document's `script-src 'self'` remains unchanged: **no** CDN or
document-wide eval permission was added. The published runtime's Emscripten
bindings use `new Function`, so `wasm-unsafe-eval` alone does not work in a real
browser. **The dedicated worker and pthread worker responses require
`unsafe-eval`, allowing generated JavaScript as well as WASM there.** This is an
explicit pilot-only security tradeoff, not a CSP-compatible upstream build;
remove the exception when a verified no-dynamic-execution build is available.
Never copy this policy onto the chat document. Worker `connect-src 'none'`,
disabled fetch/XHR and in-memory files prevent catalog/model network fallbacks.
Main-thread asset fetches are same-origin, size-limited, no-store, without
credentials/referrer/redirects. No audio/text is posted to a network endpoint.

COOP may affect opener-based login flows; COEP may block third-party resources
that lack CORS/CORP. That is why isolation is an **operator opt-in**, not a
blanket production change. Evaluate existing embeds/auth/calls before deploying
these document headers. Default hosts without isolation keep captions disabled.
The pilot does not install a service worker or override an existing one: deploy
on a host without a caching service worker for these paths.

## Exact published artifact and model provenance

Reviewed on 2026-10-28: [npm 0.1.5 metadata](https://registry.npmjs.org/@moonshine-ai/moonshine-wasm/0.1.5)
and [actual tarball](https://registry.npmjs.org/@moonshine-ai/moonshine-wasm/-/moonshine-wasm-0.1.5.tgz).
Installed with `bun add --exact --ignore-scripts @moonshine-ai/moonshine-wasm@0.1.5`.
The lockfile pins tarball SHA-512:
`b90GVFkbuQQthW8wZFU/dvJpnnsISHSSxs/p6Xv/NMfaHotLhRp0e9Risy5/np6QSF3SFust3jGE3Uj2LdecmQ==`.

The artifact's `ModelArch.TinyStreaming` is **2**. Its low-level
`Transcriber.load({ module, files, modelArch, options })` accepts canonical
filename-to-Uint8Array maps. `identify_speakers` and `word_timestamps` are false;
no spelling buffers/flags are supplied. We do **not** use `MicTranscriber` (it
defaults to Medium and `start()` calls `load()`), `AssetDownloader`'s cache/catalog
paths, or the high-level worker host (which only accepts URL/catalog sources).
Our worker injects the verified WASM bytes and uses a two-thread pthread pool.

**Important mismatch:** GitHub tag `v0.1.5` dereferences to
`234f60faa0eb388b01cdf7e60aca232af37aefda`, whose
[catalog](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/moonshine-model-catalog.cpp#L44)
describes `quantized_26_08_21` with split frontend files. The npm binary itself
instead returns `quantized_26_07_30` and a single `frontend.ort` from
`sttDependencies("en", "2", false)`. We extracted that **binary's own manifest**
and checked the actual downloaded files against all its sizes and CRC32C values,
then computed SHA-256 locally over those HTTPS downloads. This is not an
independently signed upstream SHA-256 claim. The worker rechecks the embedded
catalog identity before constructing a transcriber.

Source for every model row:
`https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_07_30/<filename>`.
All exact runtime/model size, SHA-256 and CRC32C pins live in
`client/src/lib/localCaptionAssets.json` (the staging script and browser share it).

| Model file | Bytes | Locally derived SHA-256 |
| --- | ---: | --- |
| adapter.ort | 1,319,664 | `22ecc949e146c49667fda28d102d4e30749a107dc88a396292aa8f277ef1347c` |
| cross_kv.ort | 1,287,544 | `143a36667b8d05fd9d04e8c337b7ee121f37ef299aea6b3d82bdb3d3401950b4` |
| decoder_kv.ort | 32,583,720 | `8852553f312adb6c9aa4d17418015049b30f412209ee569d336548c0044627de` |
| encoder.ort | 7,675,440 | `a8414e1a5dedf9f2093d7680601dd8a9b0433e7020260eafe0e370ead91134ca` |
| frontend.ort | 8,324,920 | `271a563251f11e6311949530f8025ed4d345c5d69d4ac1efa74093779927d636` |
| streaming_config.json | 509 | `74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950` |
| tokenizer.bin | 249,974 | `6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d` |

Total model: **51,441,771 bytes**. Runtime WASM: 13,155,937 bytes,
SHA-256 `d0e783f661f8be68f7af48d859d3bbc7a6381a980b35b4128fc36344218a6682`.
Runtime Emscripten JS: 156,457 bytes,
SHA-256 `a4b40a7cf7a810e3cdbe8c12f3dd47598900566117b824da690585deb79c59e2`.
The eight used wrapper JS files total 40,026 bytes. Combined verified fetch:
**64,794,191 bytes**, not a compressed-transfer or peak-memory claim.

CDN HEAD gave MD5-style ETags, no SHA-256. Upstream's
[metadata generator](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/scripts/generate-model-file-metadata.py#L135-L160)
documents migration from GCS to R2 and CRC32C-only metadata. Candidate SHA256SUMS,
sha256sums.txt, manifest.json and checksums.json paths returned 404. Hugging Face
LFS exposes SHA-256 for a **different** Tiny export (e.g. decoder 95,346,024 versus
32,583,720 bytes); those hashes were not substituted. The exact Tiny-only
validation download was explicitly authorized; no Medium/extras were fetched.

The npm package declares MIT but omits a LICENSE file. The staging script ships
upstream MIT/model notices and licenses for Eigen (MPL-2.0 subset), ONNX Runtime,
kaldi-native-fbank, kissfft, utf8proc, UTF-8, nlohmann, doctest and cpp-annote.
Source revision is pinned in the script. [Upstream licensing](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/docs/license.md)
states English and all streaming STT models are MIT; unrelated non-English legacy
and TTS model licenses do not authorize any additional model download here.

## Checks and evaluation protocol

```sh
# No weight downloads or inference in unit tests:
node --experimental-strip-types --test test/localCaptions.test.ts test/voiceCaptureLifecycle.test.ts
bun run typecheck
bunx eslint src/components/settings/VoiceTab.tsx src/components/settings/LocalCaptionPilot.tsx src/lib/localCaptions.ts
bun run build
# Explicit offline real-engine check of already downloaded Tiny files:
node scripts/check-local-captions.mjs /tmp/tiny-en
# Optional known-speech control: raw mono float32 little-endian PCM at 16kHz
node scripts/check-local-captions.mjs /tmp/tiny-en /tmp/known-speech.f32
```

The smoke command checks SHA-256 + CRC32C + binary catalog, then silence (or
nonempty speech when explicitly supplied), printing numeric metadata only.
It is **not WER or browser latency evidence**. The preview reports actual
per-session download/check duration, worker/model load duration, first text
since microphone start (includes initial silence), worker feed+transcribe wall
time and dropped audio. Feed+transcribe includes throttled/no-op passes and
segmentation, not pure neural inference. These are not a product benchmark.

Local Node/WASM smoke checks in this Linux x64 orb on 2026-10-28 passed all
model SHA-256, CRC32C and embedded-catalog checks. Two seconds of generated
silence produced no text (343 ms load, 83 ms processing); the public upstream
`test-assets/beckett.wav` at the source revision above, converted by ffmpeg to
16 kHz float32 mono, produced nonempty captions for 9.963375 seconds of audio
(405 ms load, 1,645 ms processing). These are single, non-real-time controls,
not browser latency, WER, or target-device performance results. No hypothesis
text was logged or persisted. No paid model or remote inference was used.

Memory/battery telemetry is **unsupported**, not zero. Accuracy is **not
evaluated**. Before received-audio expansion:

1. Record device/browser/OS/mic and exact runtime/model identity. Include a
   low-end laptop and real mobile browsers (emulation is not power evidence).
   Run at least five cold/warm repeats separately, up to three minutes each.
2. Measure download separately from verification/model startup. Report sample
   count, p50/p95 first-text-from-mic-start, separately consented
   speech-onset-to-first-text delay, queue/dropped audio, UI responsiveness and
   worker processing/audio ratio. Do not interchange these latency definitions.
3. Use external browser/OS tooling for peak total process memory; JS heap APIs
   omit WASM/worker/native allocations. Use a controlled physical power test
   for energy if available, otherwise say unsupported; don't infer battery from
   inference duration.
4. With consented English reference passages, test at least 20 utterances per
   condition: names/numbers, accents, quiet/noisy speech and silence. Normalize
   case/punctuation consistently; manually align final hypotheses; report WER
   `(substitutions + deletions + insertions) / reference words`, raw counts,
   failures, lost negations, hallucinations and partial revisions. Keep manual
   references outside app storage; do not add automatic transcript export.
5. Agree explicit accuracy/lag/CPU/power budgets, review results and privacy/mute
   boundaries, then obtain separate expansion approval. None has been met or
   claimed by this pilot's smoke checks.
