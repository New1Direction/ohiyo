import { launchBrowser, ORIGIN, log } from "./harness.mjs";

// Plugin sandbox: untrusted code runs in a Worker with no DOM, no auth token,
// and no network. It registers, receives *sanitized* events, and proves none of
// the dangerous globals are reachable.
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async () => {
    const SandboxHost = window.__ohiyoTestSandboxHost;
    if (!SandboxHost) throw new Error("SandboxHost test hook missing");
    const toasts = [];
    const source = `
      kikkacord.definePlugin({
        id: "isolation-probe", name: "Probe", version: "1.0.0",
        onLoad: function () {
          var proto = Object.getPrototypeOf(self) || {};
          var checks = {
            fetch: typeof fetch, XMLHttpRequest: typeof XMLHttpRequest,
            WebSocket: typeof WebSocket, importScripts: typeof importScripts,
            Worker: typeof Worker, document: typeof document,
            window: typeof window, localStorage: typeof localStorage,
            indexedDB: typeof indexedDB,
            BroadcastChannel: typeof BroadcastChannel, RTCPeerConnection: typeof RTCPeerConnection,
            WebTransport: typeof WebTransport, EventSource: typeof EventSource,
            SharedWorker: typeof SharedWorker, Request: typeof Request,
            Response: typeof Response, caches: typeof caches,
            sendBeacon: (self.navigator && typeof self.navigator.sendBeacon),
            protoFetch: typeof proto.fetch, protoWebSocket: typeof proto.WebSocket,
          };
          var reachable = [];
          for (var k in checks) { if (checks[k] !== "undefined") reachable.push(k + ":" + checks[k]); }
          kikkacord.toast("probe:" + JSON.stringify(reachable), "info");
        },
        onMessage: function (m) {
          kikkacord.toast("msg:" + m.content + "|avatar:" + (m.author && m.author.avatar_url), "success");
        }
      });
    `;
    const host = new SandboxHost(source, {
      onToast: (t) => toasts.push(t),
      onError: (e) => toasts.push("ERR:" + e),
    });
    const manifest = await host.ready();
    host.start();
    await new Promise((r) => setTimeout(r, 250));
    // Dispatch a message carrying a secret field the plugin must NOT see.
    host.dispatch("message", {
      id: "1", channel_id: "c", content: "hello-sandbox", created_at: 1,
      author: { id: "a", username: "u", display_name: "U", avatar_url: "SECRET_SHOULD_BE_STRIPPED" },
    });
    await new Promise((r) => setTimeout(r, 250));
    host.terminate();
    return { manifest, toasts };
  });

  if (result.manifest?.id !== "isolation-probe") throw new Error("plugin did not register via definePlugin");
  log("sandboxed plugin registered ✓");

  const probe = result.toasts.find((t) => t.startsWith("probe:"));
  if (!probe) throw new Error("plugin onLoad never ran");
  const reachableGlobals = JSON.parse(probe.slice("probe:".length));
  if (reachableGlobals.length) {
    throw new Error(`SECURITY: globals reachable inside sandbox: ${reachableGlobals.join(", ")}`);
  }
  log("no DOM · no network · no storage reachable from sandbox (incl. prototype chain) ✓");

  const msg = result.toasts.find((t) => t.startsWith("msg:"));
  if (!msg || !msg.includes("hello-sandbox")) throw new Error("plugin did not receive dispatched event");
  if (!msg.includes("avatar:undefined")) throw new Error("SECURITY: unsanitized internal field leaked into sandbox");
  log("receives sanitized events; internal fields stripped ✓");

  console.log("\n✅ PLUGIN SANDBOX PASSED (isolation · no token/DOM/network · sanitized events)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
