// Exercise the Dockerfile's actual build command, using a tiny Vite entrypoint
// instead of the app so this checks packaging independently of app assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const client = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(join(client, "Dockerfile.selfhosted"), "utf8");
const command = dockerfile.match(/RUN node --input-type=module [\s\S]*?rm -f dist\/_headers/)?.[0]
  .replace(/^RUN /, "").replace(/\\\n/g, "");
assert.ok(command, "Dockerfile contains the required-origin build command");

function build(origin: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-packaging-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, ".env.production"), readFileSync(join(client, ".env.production")));
    writeFileSync(join(dir, "index.html"), '<html><head></head><body><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(dir, "main.js"), 'document.body.textContent = import.meta.env.VITE_SERVER_URL;');
    // The command still invokes the real Vite config (and thus the production CSP).
    writeFileSync(join(dir, "bin/bun"), `#!/bin/sh\nexec '${process.execPath}' '${join(client, "node_modules/vite/bin/vite.js")}' build --config '${join(client, "vite.config.ts")}'\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
    delete env.VITE_SERVER_URL;
    if (origin !== undefined) env.VITE_SERVER_URL = origin;
    const result = spawnSync("sh", ["-c", command!], { cwd: dir, env, encoding: "utf8" });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      html: result.status === 0 ? readFileSync(join(dir, "dist/index.html"), "utf8") : "",
      bundle: result.status === 0 ? readdirSync(join(dir, "dist/assets"))
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(dir, "dist/assets", file), "utf8")).join("\n") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("self-hosted builds require an API origin instead of falling back to Railway", () => {
  for (const value of [undefined, ""]) {
    const result = build(value);
    assert.notEqual(result.status, 0, "accepted a missing API origin");
  }
});

test("self-host origins produce matching HTTP and WebSocket CSP sources", () => {
  for (const origin of ["https://api.selfhost.test:8443", "http://127.0.0.1:3000", "https://api.selfhost.test/"]) {
    const result = build(origin);
    assert.equal(result.status, 0, result.output);
    const url = new URL(origin);
    const ws = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    assert.ok(result.html.includes(`connect-src 'self' ${url.origin} ${ws}`), result.html);
    assert.ok(result.bundle.includes(origin));
  }
});

test("invalid build-time API addresses stop the build", () => {
  for (const origin of ["/api", "api.example.com", "ftp://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?x=1", "https://example.com#x", " https://example.com", "https://example.com/../", "https://example.com\\evil", "https://example.com\\", "https://exam\nple.com", "https://example.com\n"]) {
    const result = build(origin);
    assert.notEqual(result.status, 0, `accepted ${origin}`);
  }
});
