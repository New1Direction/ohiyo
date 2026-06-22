/**
 * Worker-based plugin sandbox.
 *
 * Untrusted (remote) plugin code runs inside a Web Worker that has NO access to
 * the DOM, `window`, `localStorage`, cookies, or the auth token — and whose
 * network primitives (`fetch`/`XHR`/`WebSocket`/`importScripts`/nested Workers)
 * are deleted before the plugin code executes. With no ambient I/O it cannot
 * exfiltrate anything it is given. The host talks to it only over a narrow,
 * validated postMessage RPC and forwards a *sanitized* subset of app events.
 *
 * Sandboxed plugins author against a global `kikkacord` API (see BOOTSTRAP):
 *   kikkacord.definePlugin({ id, name, version, css, onLoad, onMessage, ... })
 *   await kikkacord.store.get/set/del(key)   // namespaced, host-mediated
 *   kikkacord.toast(text, type)              // host-mediated, rate-limited
 *   kikkacord.log(...args)
 *
 * Async RPC means sandboxed plugins get event hooks + storage + toasts, not the
 * synchronous transformMessage/transformSend pipeline (that stays for trusted,
 * built-in plugins only).
 */
import type { Message } from "../api";
import type { PluginEventName } from "./api";

export type SandboxManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  css: string;
};

type StoreBackend = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  del: (key: string) => void;
};

type SandboxOptions = {
  onToast: (text: string, type: string) => void;
  onError: (message: string) => void;
};

const REGISTER_TIMEOUT_MS = 5000;
const MAX_TOASTS_PER_10S = 5;

// Runs as the first statement in the worker, BEFORE the plugin source (which is
// concatenated after it). Classic worker (no ESM) so a plugin's accidental
// top-level `import`/`export` would be a syntax error caught at construction.
const BOOTSTRAP = `
(function () {
  "use strict";
  var manifest = null, hooks = {}, rpcId = 0, pending = {};
  function post(type, payload) { self.postMessage({ __kc: true, type: type, payload: payload }); }
  function rpc(method, args) {
    return new Promise(function (resolve) { var id = ++rpcId; pending[id] = resolve; post("rpc", { id: id, method: method, args: args }); });
  }
  self.kikkacord = {
    definePlugin: function (def) {
      if (!def || !def.id || !def.name) { post("error", "Plugin must have id and name"); return; }
      // The id is used as a localStorage key prefix (\`plugin:<id>:\`) on the host,
      // so allowlist it to safe chars — otherwise a crafted id could collide with
      // another plugin's store or escape the namespace.
      if (!/^[A-Za-z0-9._-]+$/.test(String(def.id))) { post("error", "Plugin id must match ^[A-Za-z0-9._-]+$"); return; }
      manifest = {
        id: String(def.id), name: String(def.name),
        description: String(def.description || ""), version: String(def.version || "0.0.0"),
        author: String(def.author || ""), css: typeof def.css === "string" ? def.css : "",
      };
      hooks = {
        onLoad: def.onLoad, onUnload: def.onUnload, onMessage: def.onMessage,
        onChannelSelect: def.onChannelSelect, onServerSelect: def.onServerSelect, onReady: def.onReady,
      };
      post("register", manifest);
    },
    store: {
      get: function (k) { return rpc("store.get", [String(k)]); },
      set: function (k, v) { return rpc("store.set", [String(k), v]); },
      del: function (k) { return rpc("store.del", [String(k)]); },
    },
    toast: function (text, type) { post("toast", { text: String(text).slice(0, 300), type: String(type || "info") }); },
    log: function () { post("log", Array.prototype.slice.call(arguments).map(String).join(" ")); },
  };
  // Strip all ambient I/O so a sandboxed plugin literally cannot phone home.
  // These globals live on WorkerGlobalScope.prototype, so we overwrite the
  // OWNING prototype property AND pin a non-configurable own shadow on self —
  // both bare access (\`fetch(...)\`) and prototype access (self.__proto__.fetch)
  // then resolve to undefined, and the originals become unreachable.
  function nuke(name) {
    var o = self;
    while (o) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try { Object.defineProperty(o, name, { value: undefined, writable: true, configurable: true }); }
        catch (e) { try { o[name] = undefined; } catch (e2) {} try { delete o[name]; } catch (e3) {} }
      }
      o = Object.getPrototypeOf(o);
    }
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  var kill = ["fetch","XMLHttpRequest","WebSocket","EventSource","importScripts","Worker","SharedWorker","Request","Response","caches","indexedDB","BroadcastChannel","RTCPeerConnection","WebTransport"];
  for (var i = 0; i < kill.length; i++) { nuke(kill[i]); }
  try { if (self.navigator) self.navigator.sendBeacon = undefined; } catch (e) {}
  function safe(fn, arg) { if (typeof fn === "function") { try { return fn(arg); } catch (e) { post("error", String((e && e.message) || e)); } } }
  self.onmessage = function (e) {
    var d = e.data || {};
    if (d.type === "event") {
      var map = { "message": "onMessage", "channel-select": "onChannelSelect", "server-select": "onServerSelect", "ready": "onReady" };
      safe(hooks[map[d.event]], d.data);
    } else if (d.type === "load") { safe(hooks.onLoad); }
    else if (d.type === "unload") { safe(hooks.onUnload); }
    else if (d.type === "rpc-result") { var r = pending[d.id]; if (r) { delete pending[d.id]; r(d.value); } }
  };
  post("boot", null);
})();
`;

/** Forward only safe, primitive fields to a sandboxed plugin — never internals. */
function sanitizeEvent(event: PluginEventName, data: unknown): unknown {
  if (event === "message") {
    const m = data as Message;
    if (!m) return null;
    return {
      id: m.id,
      channel_id: m.channel_id,
      content: m.content,
      created_at: m.created_at,
      author: m.author
        ? { id: m.author.id, username: m.author.username, display_name: m.author.display_name }
        : null,
    };
  }
  // For channel/server/ready, forward a shallow JSON-safe copy (no functions/refs).
  try {
    return JSON.parse(JSON.stringify(data ?? null));
  } catch {
    return null;
  }
}

/** Remove CSS exfiltration / code-execution vectors — the one channel a
 *  networkless worker (or even a "trusted" custom-CSS plugin) could still abuse
 *  via the host applying its CSS. We do NOT try to tell "safe" url()s apart:
 *  even `url(data:...)` and same-origin/relative `url()` are exfiltration or
 *  request-forgery vectors, so EVERY url(...) is neutralized. We also strip any
 *  remaining @import, legacy IE `expression(...)`, and Gecko `-moz-binding`. */
export function sanitizePluginCss(css: string): string {
  if (typeof css !== "string") return "";
  return css
    // Any @import (url or string form) — drop the whole at-rule up to ; or EOL.
    .replace(/@import[^;]*;?/gi, "")
    // Every url(...) regardless of scheme (http(s), //, data:, blob:, relative).
    .replace(/url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\)/gi, "none")
    // A bare `url(` with no closing paren (truncated/obfuscated) — neutralize too.
    .replace(/url\s*\(/gi, "none(")
    // IE expression() — arbitrary JS in legacy engines.
    .replace(/expression\s*\(/gi, "void(")
    // Gecko XBL binding — can load remote bindings / scripts.
    .replace(/-moz-binding\b/gi, "-x-disabled-binding");
}

export class SandboxHost {
  private worker: Worker;
  private store: StoreBackend | null = null;
  private manifest: Promise<SandboxManifest>;
  private resolveManifest!: (m: SandboxManifest) => void;
  private rejectManifest!: (e: Error) => void;
  private toastTimes: number[] = [];
  private terminated = false;
  private opts: SandboxOptions;

  constructor(source: string, opts: SandboxOptions) {
    this.opts = opts;
    const blob = new Blob([BOOTSTRAP, "\n", source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    this.worker = new Worker(url);
    // The worker keeps its own copy of the script; the URL can be released now.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.rejectManifest?.(new Error(e.message || "Plugin failed to load"));
    this.manifest = new Promise<SandboxManifest>((res, rej) => {
      this.resolveManifest = res;
      this.rejectManifest = rej;
      setTimeout(() => rej(new Error("Plugin did not call kikkacord.definePlugin()")), REGISTER_TIMEOUT_MS);
    });
  }

  /** Resolves with the plugin manifest once the worker calls definePlugin(). */
  ready(): Promise<SandboxManifest> {
    return this.manifest;
  }

  /** Wire the namespaced persistent store (after the id is known from ready()). */
  bindStore(store: StoreBackend) {
    this.store = store;
  }

  /** Tell the worker to run onLoad. */
  start() {
    this.worker.postMessage({ type: "load" });
  }

  /** Forward a sanitized app event to the worker. */
  dispatch(event: PluginEventName, data: unknown) {
    if (this.terminated) return;
    this.worker.postMessage({ type: "event", event, data: sanitizeEvent(event, data) });
  }

  /** Run onUnload, then tear the worker down. */
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.worker.postMessage({ type: "unload" });
    } catch {
      // worker may already be gone
    }
    setTimeout(() => this.worker.terminate(), 50);
  }

  private handle(d: { __kc?: boolean; type?: string; payload?: unknown; id?: number; method?: string; args?: unknown[] }) {
    if (!d || d.__kc !== true) return;
    switch (d.type) {
      case "register":
        this.resolveManifest(d.payload as SandboxManifest);
        break;
      case "rpc":
        this.handleRpc(d.payload as { id: number; method: string; args: unknown[] });
        break;
      case "toast":
        this.handleToast(d.payload as { text: string; type: string });
        break;
      case "log":
        console.debug("[plugin:sandbox]", d.payload);
        break;
      case "error":
        this.opts.onError(String(d.payload));
        break;
      // "boot" is informational; ignore.
    }
  }

  private handleRpc(req: { id: number; method: string; args: unknown[] }) {
    let value: unknown = null;
    const [k, v] = req.args ?? [];
    if (this.store) {
      if (req.method === "store.get") value = this.store.get(String(k));
      else if (req.method === "store.set") this.store.set(String(k), v);
      else if (req.method === "store.del") this.store.del(String(k));
    }
    this.worker.postMessage({ type: "rpc-result", id: req.id, value });
  }

  private handleToast(payload: { text: string; type: string }) {
    const now = Date.now();
    this.toastTimes = this.toastTimes.filter((t) => now - t < 10_000);
    if (this.toastTimes.length >= MAX_TOASTS_PER_10S) return; // rate-limit noisy plugins
    this.toastTimes.push(now);
    this.opts.onToast(payload.text, payload.type);
  }
}
