// Explicit operator action only. Never invoked by install, dev, build or the app.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const client = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(client, "src/lib/localCaptionAssets.json"), "utf8"));
const output = join(client, "public", manifest.base);
const runtime = join(client, "node_modules/@moonshine-ai/moonshine-wasm");
const metadata = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
if (metadata.version !== manifest.version || metadata.license !== "MIT") throw new Error("Install the reviewed pinned dependency first");

async function get(url) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
function verify(bytes, size, hash, filename) {
  if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`Integrity mismatch: ${filename}`);
}
await mkdir(join(output, "runtime"), { recursive: true });
await mkdir(join(output, "models"), { recursive: true });
for (const [name, size, hash] of manifest.runtime) {
  const bytes = await readFile(join(runtime, "dist", name));
  verify(bytes, size, hash, name);
  await writeFile(join(output, "runtime", name), bytes);
}
// Optional previously downloaded Tiny directory; it gets exactly the same checks.
for (const [name, size, hash] of manifest.models) {
  const bytes = process.argv[2] ? await readFile(join(process.argv[2], name)) : await get(`${manifest.source}${name}`);
  verify(bytes, size, hash, name);
  await writeFile(join(output, "models", name), bytes);
}
const revision = "234f60faa0eb388b01cdf7e60aca232af37aefda";
const notices = ["LICENSE", "docs/license.md", "core/cpp-annote/LICENSE", "core/third-party/Eigen/COPYING.MPL2",
  "core/third-party/doctest/LICENSE.txt", "core/third-party/kaldi-native-fbank/LICENSE", "core/third-party/kissfft/COPYING",
  "core/third-party/nlohmann/LICENSE.MIT", "core/third-party/onnxruntime/LICENSE.txt", "core/third-party/utf-8/LICENSE.txt",
  "core/third-party/utf8proc/LICENSE.md"];
let text = `Moonshine Tiny Streaming English ${manifest.revision}; npm runtime ${manifest.version}.\nUpstream license source revision: ${revision}.\nThe npm artifact omits notices; the upstream source's applicable notices are reproduced below.\nSHA-256 pins in this deployment are locally derived over HTTPS, not independently signed.\n\n`;
for (const path of notices) {
  text += `\n===== ${path} =====\n${new TextDecoder().decode(await get(`https://raw.githubusercontent.com/moonshine-ai/moonshine/${revision}/${path}`))}\n`;
}
await writeFile(join(output, "NOTICES.txt"), text);
await writeFile(join(output, "identity.json"), JSON.stringify(manifest, null, 2));
await copyFile(join(client, "scripts/local-caption-worker.mjs"), join(output, "worker.mjs"));
await copyFile(join(client, "scripts/local-caption-worklet.js"), join(output, "capture.js"));
console.log(`Staged verified Tiny English assets at ${output}. Serve with documented isolation and worker CSP headers. No inference or microphone was started.`);
