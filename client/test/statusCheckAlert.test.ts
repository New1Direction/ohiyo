// The outage check (scripts/status-check.sh, run every 30 minutes by Reliability Alerts) must
// reach a person when something is down. Local fixtures exercise outages and Vite's
// HTML-linked / lazy CSS graphs. Deploy tests stub both write-capable commands.
//   node --experimental-strip-types --test test/statusCheckAlert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "status-check.sh");

type Posted = { headers: IncomingHttpHeaders; body: string };
type Route = { body: string; status?: number; headers?: Record<string, string> };
type Routes = Record<string, Route>;

async function runCheck(extraEnv: Record<string, string>, routes?: Routes, deploy = false) {
  const posted: Posted[] = [];
  const requested: string[] = [];
  const stubs = deploy ? await mkdtemp(join(tmpdir(), "ohiyo-deploy-test-")) : undefined;
  if (stubs) {
    for (const command of ["railway", "gh"]) {
      await writeFile(join(stubs, command), `#!/bin/sh\nprintf '%s\\n' '${command}' "$@" >> "$STUB_LOG"\n`, { mode: 0o755 });
    }
  }
  const server = createServer((req, res) => {
    requested.push(req.url ?? "");
    if (req.url === "/hook" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        posted.push({ headers: req.headers, body });
        res.end("ok");
      });
      return;
    }
    const route = routes?.[req.url ?? ""];
    res.statusCode = route?.status ?? (route ? 200 : routes ? 404 : 500);
    res.setHeader("Content-Type", req.url?.endsWith(".js") ? "text/javascript" : req.url?.endsWith(".css") ? "text/css" : "text/html");
    for (const [key, value] of Object.entries(route?.headers ?? {})) res.setHeader(key, value);
    res.end(route?.body ?? "down");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let output = "";
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("bash", [deploy ? join(dirname(script), "deploy-web.sh") : script], {
        env: {
          PATH: `${stubs ? `${stubs}:` : ""}${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? "",
          STUB_LOG: stubs ? join(stubs, "calls") : "",
          LANDING_URL: `${base}/landing`,
          APP_URL: base,
          API_URL: `${base}/api`,
          ALERT_WEBHOOK_URL: `${base}/hook`,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, posted, requested, output, calls: stubs ? await readFile(join(stubs, "calls"), "utf8") : "" };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (stubs) await rm(stubs, { recursive: true, force: true });
  }
}

test("a failed check reaches an ntfy topic as readable text", async () => {
  const { code, posted } = await runCheck({ ALERT_WEBHOOK_FORMAT: "ntfy" });
  assert.equal(code, 1);
  assert.equal(posted.length, 1);
  const [alert] = posted;
  assert.match(String(alert.headers.title), /Ohiyo/);
  assert.doesNotMatch(alert.body, /^\s*\{/, "ntfy shows the body as is, so it must not be JSON");
  assert.match(alert.body, /\n- landing returned HTTP 500/);
});

test("a failed check reaches a chat webhook as JSON with real line breaks", async () => {
  const { code, posted } = await runCheck({});
  assert.equal(code, 1);
  assert.equal(posted.length, 1);
  const payload = JSON.parse(posted[0].body);
  assert.equal(payload.content, payload.text);
  assert.match(payload.text, /\n- landing returned HTTP 500/);
  assert.doesNotMatch(payload.text, /\\n/, "a literal backslash-n shows up as text in Slack and Discord");
});

const entry = "assets/index-D3m6v9gZ.js";
const css = "assets/index-COn_tf-U.css";
const app = "assets/App-lazy.js";
const lazyCss = "assets/Burrow-lazy.css";

function healthyRoutes(lazy = false): Routes {
  return {
    "/": { body: `<script type="module" src="/${entry}"></script>${lazy ? "" : `<link rel="stylesheet" href="/${css}">`}` },
    [`/${entry}`]: { body: lazy ? `const deps=["${css}","${app}"]; import("./App-lazy.js");` : "console.log('ready');" },
    [`/${app}`]: { body: `const deps=["${lazyCss}","${entry}"]; import("./index-AAAA.js");` },
    "/assets/index-AAAA.js": { body: "console.log('shared chunk, not entry');" },
    [`/${css}`]: { body: "body { color: black; }" },
    [`/${lazyCss}`]: { body: ".burrow { display: block; }" },
    "/landing": { body: "landing" },
    "/api/healthz": { body: "ok" },
    "/api/api/v1/push/config": { body: JSON.stringify({ enabled: true, vapid_public_key: "test-key" }) },
    "/api/api/v1/reliability/status": { body: JSON.stringify({ ok: true, components: ["database", "gateway", "voice", "instant_servers", "push_relay"].map((name) => ({ name, status: "ok", detail: "healthy" })) }) },
  };
}

for (const lazy of [false, true]) {
  test(`${lazy ? "JS-referenced lazy" : "HTML-linked"} CSS passes status and stubbed deploy`, async () => {
    const routes = healthyRoutes(lazy);
    for (const expected of ["", entry, `${entry}, ${css}`]) {
      const result = await runCheck({ EXPECTED_APP_BUNDLE: expected }, routes);
      assert.equal(result.code, 0, result.output);
      assert.equal(result.posted.length, 0);
      assert.ok(result.requested.includes(`/${css}`));
      if (lazy) {
        assert.ok(result.requested.includes(`/${lazyCss}`));
        assert.equal(result.requested.filter((path) => path === `/${entry}`).length, 1, "cycles are deduplicated");
      }
    }
    const deploy = await runCheck({}, routes, true);
    assert.equal(deploy.code, 0, deploy.output);
    assert.match(deploy.calls, /railway\nup\n/);
    assert.match(deploy.calls, new RegExp(`gh\\nvariable\\nset\\nOHIYO_EXPECTED_APP_BUNDLE\\n--repo\\nNew1Direction/ohiyo\\n--body\\n${entry}\\n$`));
  });
}

const brokenGraphs: { name: string; change: (routes: Routes) => void; error: RegExp }[] = [
  { name: "empty HTML", change: (r) => { r["/"].body = ""; }, error: /missing (HTML|index JS)/ },
  { name: "missing entry JS", change: (r) => { r["/"].body = `<link rel="stylesheet" href="/${css}">`; }, error: /missing index JS/ },
  { name: "missing all CSS", change: (r) => { r[`/${entry}`].body = "console.log('no styles');"; }, error: /missing CSS/ },
  { name: "unavailable entry JS", change: (r) => { delete r[`/${entry}`]; }, error: /index-D3m6v9gZ.js unavailable/ },
  { name: "unavailable main CSS", change: (r) => { delete r[`/${css}`]; }, error: /index-COn_tf-U.css unavailable/ },
  { name: "unavailable HTML-linked CSS", change: (r) => { r["/"].body += `<link rel="stylesheet" href="/assets/linked-missing.css">`; }, error: /linked-missing.css unavailable/ },
  { name: "unavailable lazy JS", change: (r) => { delete r[`/${app}`]; }, error: /App-lazy.js unavailable/ },
  { name: "unavailable lazy CSS", change: (r) => { delete r[`/${lazyCss}`]; }, error: /Burrow-lazy.css unavailable/ },
  { name: "CSS HTML fallback", change: (r) => { r[`/${css}`] = { body: "<html>fallback</html>", headers: { "Content-Type": "text/html" } }; }, error: /expected css, got text\/html/ },
  { name: "JS HTML fallback", change: (r) => { r[`/${app}`] = { body: "<html>fallback</html>", headers: { "Content-Type": "text/html" } }; }, error: /expected js, got text\/html/ },
  { name: "asset redirect outside assets", change: (r) => { r[`/${css}`] = { body: "", status: 302, headers: { Location: "/outside.css" } }; }, error: /redirected outside same-origin/ },
  { name: "asset redirect to external origin", change: (r) => { r[`/${css}`] = { body: "", status: 302, headers: { Location: "https://external.invalid/assets/foreign.css" } }; }, error: /redirected outside same-origin/ },
];

for (const { name, change, error } of brokenGraphs) {
  test(`${name} fails status with alert and prevents deploy variable write`, async () => {
    const routes = healthyRoutes(true);
    change(routes);
    const result = await runCheck({}, routes);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, error);
    assert.equal(result.posted.length, 1);
    assert.match(JSON.parse(result.posted[0].body).text, error);
    assert.ok(!result.requested.includes("/outside.css"));
    assert.ok(result.requested.includes("/api/api/v1/reliability/status"), "API checks still run");
    const deploy = await runCheck({}, routes, true);
    assert.equal(deploy.code, 1, deploy.output);
    assert.match(deploy.output, error);
    assert.doesNotMatch(deploy.calls, /gh\n/, "failed asset validation must not change the expected bundle");
  });
}

test("optional freshness rejects stale JS and CSS even if stale files remain available", async () => {
  for (const expected of ["assets/index-old.js", "assets/index-old.css"]) {
    const routes = healthyRoutes(true);
    routes[`/${expected}`] = { body: "/* old but available */" };
    if (expected.endsWith(".js")) routes[`/${app}`].body += `import("./index-old.js");`;
    const result = await runCheck({ EXPECTED_APP_BUNDLE: expected }, routes);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /app appears stale/);
    assert.equal(result.posted.length, 1);
    assert.equal(result.requested.includes(`/${expected}`), expected.endsWith(".js"),
      "a reachable retired JS is not the current HTML entry; stale CSS is not in the graph");
  }
});

test("external and out-of-assets references are not fetched or accepted as CSS", async () => {
  const routes = healthyRoutes(true);
  routes[`/${entry}`].body = 'const refs=["https://external.invalid/assets/foreign.css","//external.invalid/assets/remote.js","/outside.css","../outside.js","assets/../outside.css"];';
  const result = await runCheck({}, routes);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /missing CSS/);
  assert.deepEqual(result.requested.filter((path) => path.endsWith(".css") || path.endsWith(".js")), [`/${entry}`]);
});

test("healthy bundles do not bypass API and push failures", async () => {
  const routes = healthyRoutes(true);
  routes["/api/api/v1/reliability/status"].body = JSON.stringify({ ok: false, components: [] });
  routes["/api/api/v1/push/config"].body = JSON.stringify({ enabled: false });
  const result = await runCheck({}, routes);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /reliability status ok=false/);
  assert.match(result.output, /missing component 'database'/);
  assert.match(result.output, /push config disabled/);
  assert.equal(result.posted.length, 1);
});
