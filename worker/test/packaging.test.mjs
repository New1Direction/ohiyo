// Packaging/bootstrap checks use real Node processes, no provider inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { workerEnvironment } from "../../server/worker-supervisor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const supervisor = pathToFileURL(join(root, "server/worker-supervisor.mjs")).href;

async function until(check, detail) {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(detail);
}

test("embedded worker environment is explicit, private, routed and secret-minimal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-worker-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "worker.json");
  writeFileSync(config, JSON.stringify({ approvedUrls: [] }));
  const env = {
    KIKKA_RUNTIME: "pi", KIKKA_MODEL_ROUTING: "1", KIKKA_USER_ID: "operator",
    KIKKA_WORKER_TOKEN: "t".repeat(32), KIKKA_WORKER_CONFIG: config,
    KIKKA_ROUTING_CONFIG: "/data/kikka-routing.json", BIND_ADDR: "0.0.0.0:3000",
    KIKKA_WORKER_URL: "http://127.0.0.1:3102/command",
    KIKKA_ROUTING_ACCESS_URL: "http://127.0.0.1:3000/api/v1/burrow/internal/model-access",
    JWT_SECRET: "never-forward", AWS_SECRET_ACCESS_KEY: "never-forward", OPENAI_API_KEY: "never-forward",
    NODE_OPTIONS: "--inspect", PATH: "/untrusted", KIKKA_CONNECTION_KEY: "never-forward",
  };
  assert.deepEqual(workerEnvironment(env), {
    KIKKA_WORKER_CONFIG: config, KIKKA_WORKER_DIRECTORY: "/data/kikka",
    KIKKA_WORKER_TOKEN: env.KIKKA_WORKER_TOKEN, KIKKA_WORKER_PORT: "3102",
    KIKKA_MODEL_ROUTING: "1", KIKKA_ROUTING_ACCESS_URL: env.KIKKA_ROUTING_ACCESS_URL,
  });
  for (const change of [
    { KIKKA_RUNTIME: "" }, { KIKKA_MODEL_ROUTING: "0" }, { KIKKA_USER_ID: " " },
    { KIKKA_WORKER_TOKEN: "short" }, { KIKKA_WORKER_CONFIG: "relative.json" },
    { KIKKA_ROUTING_CONFIG: "" }, { KIKKA_WORKER_DIRECTORY: "/tmp/ephemeral" },
    { KIKKA_WORKER_PORT: "0" }, { KIKKA_WORKER_PORT: "65536" },
    { KIKKA_WORKER_URL: "http://0.0.0.0:3102/command" },
    { KIKKA_ROUTING_ACCESS_URL: "https://public.example/api/v1/burrow/internal/model-access" },
    { KIKKA_TRAVEL_URL: "http://127.0.0.1:3200" },
  ]) assert.throws(() => workerEnvironment({ ...env, ...change }));
  writeFileSync(config, JSON.stringify({ approvedUrls: [], computer: { coding: { enabled: true } } }));
  assert.throws(() => workerEnvironment(env));
});

// Each child writes its PID and handles shutdown. The API can spawn a same-group
// descendant, standing in for Litestream's managed Rust subprocess.
async function startSupervisor(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-supervisor-"));
  const fixture = join(dir, "child.mjs");
  writeFileSync(fixture, `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const [name, dir, mode] = process.argv.slice(2);
    if (name === 'api' && mode === 'descendant') spawn(process.execPath, [process.argv[1], 'descendant', dir, ''], { stdio: 'inherit' });
    process.on('SIGTERM', () => {
      writeFileSync(dir + '/' + name + '.stopped', 'SIGTERM');
      if (mode !== 'stubborn') process.exit(0);
    });
    process.on('SIGUSR1', () => process.exit(0));
    setInterval(() => {}, 1000);
    writeFileSync(dir + '/' + name + '.json', JSON.stringify({ pid: process.pid, env: process.env }));
  `);
  const workerCommand = options.missing ? [join(dir, "missing")] : [process.execPath, fixture, "worker", dir, options.stubborn ? "stubborn" : ""];
  const apiCommand = [process.execPath, fixture, "api", dir, options.descendant ? "descendant" : ""];
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { supervise } from ${JSON.stringify(supervisor)};
    process.exitCode = await supervise(${JSON.stringify({
      workerCommand, apiCommand, workerEnv: { ONLY_WORKER: "yes" },
      apiEnv: { API_SECRET: "retained" }, shutdownMs: 150,
    })});
  `], { stdio: "ignore" });
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
    rmSync(dir, { recursive: true, force: true });
  });
  const info = name => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  if (!options.missing) {
    await until(() => existsSync(join(dir, "worker.json")) && existsSync(join(dir, "api.json")), "both children start");
    assert.deepEqual(info("worker").env, { ONLY_WORKER: "yes" });
    assert.deepEqual(info("api").env, { API_SECRET: "retained" });
  }
  return { child, exit, dir, info };
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`supervisor ${signal} stops both peers and the API descendant`, { timeout: 10000 }, async (t) => {
    const run = await startSupervisor(t, { descendant: true });
    await until(() => existsSync(join(run.dir, "descendant.json")), "managed API descendant starts");
    run.child.kill(signal);
    assert.deepEqual(await run.exit, [signal === "SIGTERM" ? 143 : 130, null]);
    for (const name of ["worker", "api"]) assert.ok(existsSync(join(run.dir, `${name}.stopped`)), `${name} stopped gracefully`);
    const pid = run.info("descendant").pid;
    await until(() => !existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z", "API descendant is no longer running");
  });
}

for (const peer of ["worker", "api"]) {
  for (const signal of ["SIGKILL", "SIGUSR1"]) {
    test(`${peer} ${signal === "SIGUSR1" ? "clean exit" : "death"} stops its peer without retry`, { timeout: 10000 }, async (t) => {
      const run = await startSupervisor(t);
      process.kill(run.info(peer).pid, signal);
      assert.deepEqual(await run.exit, [1, null]);
      assert.ok(existsSync(join(run.dir, `${peer === "worker" ? "api" : "worker"}.stopped`)));
    });
  }
}

test("shutdown escalates when a worker refuses SIGTERM", { timeout: 10000 }, async (t) => {
  const run = await startSupervisor(t, { stubborn: true });
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.exit, [143, null]);
  assert.throws(() => process.kill(run.info("worker").pid, 0), { code: "ESRCH" });
});

test("spawn failure is fatal and stops the other child", { timeout: 10000 }, async (t) => {
  const run = await startSupervisor(t, { missing: true });
  assert.deepEqual(await run.exit, [1, null]);
});

test("packaging includes locked actual Pi, Node 26, the supervisor and only worker source inputs", () => {
  const docker = readFileSync(join(root, "server/Dockerfile"), "utf8");
  assert.match(docker, /FROM node:26-bookworm-slim AS worker-builder/);
  assert.match(docker, /RUN npm ci --ignore-scripts --omit=dev/);
  assert.match(docker, /COPY --from=worker-builder \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
  assert.match(docker, /COPY server\/worker-supervisor.mjs/);
  const lock = JSON.parse(readFileSync(join(root, "worker/package-lock.json"), "utf8"));
  for (const name of ["pi-durable", "pi-ai", "chord"]) assert.equal(lock.packages[`node_modules/@earendil-works/${name}`].version, "1.3.0");
  const patterns = name => readFileSync(join(root, name), "utf8").split("\n").filter(line => line && !line.startsWith("#"));
  assert.deepEqual(patterns(".dockerignore"), patterns(".railwayignore"));
  for (const rule of ["!worker/package.json", "!worker/package-lock.json", "!worker/src/**", "!server/worker-supervisor.mjs", "**/.env.*", "**/node_modules"]) assert.ok(patterns(".dockerignore").includes(rule));
});

test("invalid embedded configuration fails before starting an API", () => {
  const result = spawnSync(process.execPath, [join(root, "server/worker-supervisor.mjs")], { env: {}, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Embedded worker startup failed/);
});

for (const approvedUrls of [JSON.parse(readFileSync(join(root, "worker/config/practice-worker.json"), "utf8")).approvedUrls, Array(20).fill("https://example.com/")]) {
test(`real Pi startup accepts ${approvedUrls.length} routed pages, stays private and performs no inference`, { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-worker-boot-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ approvedUrls }));
  let accessCalls = 0;
  const api = createServer((_req, res) => { accessCalls++; res.writeHead(503); res.end(); });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiPort = api.address().port;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(() => resolve()));
  const token = "t".repeat(32);
  const child = spawn(process.execPath, [join(root, "worker/src/server.mjs")], {
    env: {
      KIKKA_WORKER_CONFIG: config, KIKKA_WORKER_DIRECTORY: join(dir, "state"),
      KIKKA_WORKER_TOKEN: token, KIKKA_WORKER_PORT: String(port), KIKKA_MODEL_ROUTING: "1",
      KIKKA_ROUTING_ACCESS_URL: `http://127.0.0.1:${apiPort}/api/v1/burrow/internal/model-access`,
    }, stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
    await new Promise(resolve => api.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let n = 0; n < 400; n++) {
    assert.equal(child.exitCode, null, errors);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/command`);
      assert.equal(response.status, 401); ready = true; break;
    } catch { await delay(10); }
  }
  assert.ok(ready, errors);
  assert.equal((await fetch(`http://127.0.0.1:${port}/command`, { headers: { Authorization: `Bearer ${token}` } })).status, 409);
  assert.equal(accessCalls, 0, "startup and command-free readiness never request a model credential");
  // Linux's socket table encodes 127.0.0.1 as 0100007F. It must not be INADDR_ANY.
  const sockets = readFileSync("/proc/net/tcp", "utf8").split("\n");
  const socket = sockets.find(line => {
    const fields = line.trim().split(/\s+/);
    return fields[3] === "0A" && fields[1]?.endsWith(`:${port.toString(16).toUpperCase().padStart(4, "0")}`);
  });
  assert.equal(socket?.trim().split(/\s+/)[1], `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});
}

test("startup retains the non-routed nonempty allowlist requirement and the 20-page upper bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-worker-validation-"));
  try {
    const config = join(dir, "config.json");
    for (const [routing, approvedUrls] of [["0", []], ["1", Array(21).fill("https://example.com/")], ["0", Array(21).fill("https://example.com/")], ["1", null]]) {
      writeFileSync(config, JSON.stringify({ approvedUrls }));
      const result = spawnSync(process.execPath, [join(root, "worker/src/server.mjs")], {
        env: { KIKKA_WORKER_CONFIG: config, KIKKA_MODEL_ROUTING: routing }, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Invalid public page allowlist/);
    }
    writeFileSync(config, JSON.stringify({ approvedUrls: ["https://example.com/"] }));
    const legacy = spawnSync(process.execPath, [join(root, "worker/src/server.mjs")], {
      env: { KIKKA_WORKER_CONFIG: config }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /OPENAI_API_KEY is missing/, "a nonempty legacy allowlist still passes page validation without starting inference");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
