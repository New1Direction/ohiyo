// The outage check (scripts/status-check.sh, run every 30 minutes by Reliability Alerts) must
// reach a person when something is down. These tests point every check at a local server that
// answers 500 and catch what the script posts to the alert address.
//   node --experimental-strip-types --test test/statusCheckAlert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "status-check.sh");

type Posted = { headers: IncomingHttpHeaders; body: string };

async function runFailingCheck(extraEnv: Record<string, string>): Promise<{ code: number | null; posted: Posted[] }> {
  const posted: Posted[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/hook" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        posted.push({ headers: req.headers, body });
        res.end("ok");
      });
      return;
    }
    res.statusCode = 500;
    res.end("down");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn("bash", [script], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANDING_URL: `${base}/landing`,
          APP_URL: `${base}/app`,
          API_URL: `${base}/api`,
          ALERT_WEBHOOK_URL: `${base}/hook`,
          ...extraEnv,
        },
        stdio: "ignore",
      });
      child.on("close", resolve);
    });
    return { code, posted };
  } finally {
    server.close();
  }
}

test("a failed check reaches an ntfy topic as readable text", async () => {
  const { code, posted } = await runFailingCheck({ ALERT_WEBHOOK_FORMAT: "ntfy" });
  assert.equal(code, 1);
  assert.equal(posted.length, 1);
  const [alert] = posted;
  assert.match(String(alert.headers.title), /Ohiyo/);
  assert.doesNotMatch(alert.body, /^\s*\{/, "ntfy shows the body as is, so it must not be JSON");
  assert.match(alert.body, /\n- landing returned HTTP 500/);
});

test("a failed check reaches a chat webhook as JSON with real line breaks", async () => {
  const { code, posted } = await runFailingCheck({});
  assert.equal(code, 1);
  assert.equal(posted.length, 1);
  const payload = JSON.parse(posted[0].body);
  assert.equal(payload.content, payload.text);
  assert.match(payload.text, /\n- landing returned HTTP 500/);
  assert.doesNotMatch(payload.text, /\\n/, "a literal backslash-n shows up as text in Slack and Discord");
});
