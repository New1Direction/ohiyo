// The self-hosted API image downloads release files while it builds. Each
// download must be pinned to a checksum, so a replaced or tampered release
// fails the build instead of reaching a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const dockerfile = readFileSync(join(root, "server/Dockerfile.selfhosted"), "utf8");

// Litestream v0.3.13 .deb packages, checked from two networks on 2026-10-22.
const LITESTREAM_SHA256: Record<string, string> = {
  amd64: "9b05043523c1fb1c4f9800623adf0015683da7fdd55e19b9fe5d28f63fae96b4",
  arm64: "073aceebd2bbd58213aad2e05fdf4667ff4ca1140d0be6df308859798c74e8e8",
};

const remoteAdds = dockerfile
  .split("\n")
  .filter((line) => /^ADD\b/.test(line) && /https?:\/\//.test(line));

test("every remote file the API image adds is pinned to a sha256 checksum", () => {
  assert.ok(remoteAdds.length > 0, "the image downloads Litestream with ADD");
  for (const line of remoteAdds) {
    assert.match(line, /--checksum=sha256:[0-9a-f]{64}\s/, `unpinned download: ${line}`);
  }
});

test("each supported architecture installs the Litestream package with its known checksum", () => {
  for (const [arch, sum] of Object.entries(LITESTREAM_SHA256)) {
    const line = remoteAdds.find((add) => add.includes(`litestream-v0.3.13-linux-${arch}.deb`));
    assert.ok(line, `no pinned Litestream download for ${arch}`);
    assert.ok(line.includes(`--checksum=sha256:${sum}`), `wrong Litestream checksum for ${arch}`);
  }
});

test("the runtime installs Litestream only from the checksum-verified stage", () => {
  assert.doesNotMatch(dockerfile, /\$\{TARGETARCH\}\.deb/, "a download URL still depends on the build architecture");
  assert.match(dockerfile, /COPY --from=litestream-download \/litestream\.deb \/tmp\/litestream\.deb/);
});
