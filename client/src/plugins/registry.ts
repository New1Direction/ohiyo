import type { OhiyoPlugin, PluginAPI, PluginEventHandler, PluginEventName } from "./api";
import type { Message } from "../api";
import { SandboxHost, sanitizePluginCss } from "./sandbox";

if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  (window as typeof window & { __ohiyoTestSandboxHost?: typeof SandboxHost }).__ohiyoTestSandboxHost = SandboxHost;
}

// Allowlist for the user-configurable font-picker value before it is
// interpolated into a `font-family` declaration. Letters, digits, spaces and a
// small set of separators only — no characters that could escape the rule.
const FONT_FAMILY_RE = /^[A-Za-z0-9 ,_-]+$/;

// Persisted record for an installed user (third-party) plugin. `id` is the
// resolved plugin manifest id; it is optional only for legacy url-only entries.
type UserPluginEntry = { id?: string; url: string };

// ── Built-in plugins ──────────────────────────────────────────────────────────

const compactModePlugin: OhiyoPlugin = {
  id: "compact-mode",
  name: "Compact Mode",
  description: "Reduces message padding for denser chat layout.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: () => {
    document.documentElement.classList.add("plugin-compact");
  },
  onUnload: () => {
    document.documentElement.classList.remove("plugin-compact");
  },
  css: `
    .plugin-compact .msg-group { margin-bottom: 2px !important; }
    .plugin-compact .msg-content { line-height: 1.3 !important; }
    .plugin-compact .msg-avatar { display: none !important; }
    .plugin-compact .msg-meta { display: inline !important; margin-right: 6px; }
  `,
};

const customCssPlugin: OhiyoPlugin = {
  id: "custom-css",
  name: "Custom CSS",
  description: "Inject your own CSS into Ohiyo.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: (api) => {
    const css = api.store.get<string>("custom-css") ?? "";
    // Even though this is a "trusted" built-in, the CSS body is fully
    // user-controlled, so run it through the same sanitizer used for
    // untrusted third-party plugins (strips url()/@import/expression()/etc.).
    injectStyle("custom-css-plugin", sanitizePluginCss(css));
  },
  onUnload: () => {
    document.getElementById("custom-css-plugin")?.remove();
  },
};

const mentionHighlightPlugin: OhiyoPlugin = {
  id: "mention-highlight",
  name: "Mention Highlight",
  description: "Highlights messages that mention your username.",
  version: "1.0.0",
  author: "Ohiyo",
  transformMessage: (msg) => {
    const user = window.__kikkacordUser ?? null;
    if (!user) return msg;
    const mentioned =
      msg.content.includes(`@${user.username}`) ||
      msg.content.includes(`@${user.display_name}`);
    if (mentioned) {
      return { ...msg, content: `🔔 ${msg.content}` };
    }
    return msg;
  },
};

const linkPreviewPlugin: OhiyoPlugin = {
  id: "link-preview",
  name: "Link Preview",
  description: "Shows URL previews in messages (title + favicon).",
  version: "1.0.0",
  author: "Ohiyo",
  css: `
    .link-preview {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-input);
      font-size: 11px;
      color: var(--text-muted);
      text-decoration: none;
      margin-left: 4px;
      transition: background 0.1s;
    }
    .link-preview:hover { background: var(--bg-hover); }
  `,
};

const codeHighlightPlugin: OhiyoPlugin = {
  id: "code-highlight",
  name: "Code Highlight",
  description: "Syntax-highlights ``` code blocks in messages.",
  version: "1.0.0",
  author: "Ohiyo",
  css: `
    .code-block {
      display: block;
      background: #1e1e2e;
      color: #cdd6f4;
      border-radius: 6px;
      padding: 10px 14px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 13px;
      overflow-x: auto;
      margin: 6px 0;
      border-left: 3px solid var(--accent);
    }
  `,
};

const messageSoundPlugin: OhiyoPlugin = {
  id: "message-sound",
  name: "Message Sounds",
  description: "Plays a subtle sound on new messages.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: (api) => {
    api.on("message", () => {
      playTick();
    });
  },
};

const keyboardNavPlugin: OhiyoPlugin = {
  id: "keyboard-nav",
  name: "Keyboard Navigator",
  description: "Alt+1..9 to jump to servers, Ctrl+K to open channel search.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: () => {
    document.addEventListener("keydown", handleKeyNav);
  },
  onUnload: () => {
    document.removeEventListener("keydown", handleKeyNav);
  },
};

const zenModePlugin: OhiyoPlugin = {
  id: "zen-mode",
  name: "Zen Mode",
  description: "Hides server and channel sidebars for focused chat.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: () => {
    document.documentElement.classList.add("plugin-zen");
  },
  onUnload: () => {
    document.documentElement.classList.remove("plugin-zen");
  },
  css: `
    .plugin-zen .server-sidebar,
    .plugin-zen .channel-sidebar { display: none !important; }
  `,
};

const fontPickerPlugin: OhiyoPlugin = {
  id: "font-picker",
  name: "Font Picker",
  description: "Change the app font. Configure in plugin settings.",
  version: "1.0.0",
  author: "Ohiyo",
  onLoad: (api) => {
    const stored = api.store.get<string>("font") ?? "inherit";
    // The font value is interpolated straight into a <style>, so allowlist it to
    // a conservative font-family character set (letters, digits, space, comma,
    // underscore, hyphen). Anything else (quotes, braces, semicolons, url(), …)
    // would let an attacker break out of the declaration — fall back to inherit.
    const font = FONT_FAMILY_RE.test(stored) ? stored : "inherit";
    injectStyle("font-picker-plugin", `body { font-family: ${font}, sans-serif !important; }`);
  },
  onUnload: () => {
    document.getElementById("font-picker-plugin")?.remove();
  },
};

const spoilerPlugin: OhiyoPlugin = {
  id: "spoiler-text",
  name: "Spoiler Text",
  description: "Wrap text in ||spoiler|| to hide it — click to reveal.",
  version: "1.0.0",
  author: "Ohiyo",
  transformMessage: (msg) => {
    if (!msg.content.includes("||")) return msg;
    return {
      ...msg,
      content: msg.content.replace(/\|\|(.+?)\|\|/g, "【SPOILER:$1】"),
    };
  },
  css: `
    [data-spoiler] {
      background: var(--text-secondary);
      color: transparent;
      border-radius: 3px;
      cursor: pointer;
      user-select: none;
      transition: all 0.2s;
      padding: 0 2px;
    }
    [data-spoiler].revealed {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
  `,
};

const chatCommandsPlugin: OhiyoPlugin = {
  id: "chat-commands",
  name: "Chat Commands",
  description: "/shrug /me /tableflip /unflip /lenny in your messages.",
  version: "1.0.0",
  author: "Ohiyo",
  transformSend: (text) => {
    const trimmed = text.trim();
    if (trimmed === "/shrug") return "¯\\_(ツ)_/¯";
    if (trimmed === "/tableflip") return "(╯°□°）╯︵ ┻━┻";
    if (trimmed === "/unflip") return "┬─┬ノ( º _ ºノ)";
    if (trimmed === "/lenny") return "( ͡° ͜ʖ ͡°)";
    if (trimmed === "/party") return "🎉🎊🥳 PARTY TIME 🥳🎊🎉";
    if (trimmed.startsWith("/me ")) return `_${trimmed.slice(4)}_`;
    if (trimmed.startsWith("/spoiler ")) return `||${trimmed.slice(9)}||`;
    return text;
  },
};

const bigEmojiPlugin: OhiyoPlugin = {
  id: "big-emoji",
  name: "Big Emoji",
  description: "Messages containing only 1–3 emoji are displayed larger.",
  version: "1.0.0",
  author: "Ohiyo",
  transformMessage: (msg) => {
    const stripped = msg.content.replace(/\s/g, "");
    const emojiRe = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})+$/u;
    const emojiCount = [...stripped].filter((c) =>
      /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(c)
    ).length;
    if (emojiRe.test(stripped) && emojiCount >= 1 && emojiCount <= 3) {
      return { ...msg, content: `【BIG_EMOJI:${msg.content.trim()}】` };
    }
    return msg;
  },
  css: `
    .big-emoji-char { font-size: 2.5rem; line-height: 1.2; }
  `,
};

const timestampPlugin: OhiyoPlugin = {
  id: "discord-timestamps",
  name: "Discord Timestamps",
  description: "Renders <t:UNIX> and <t:UNIX:R> like Discord's timestamp format.",
  version: "1.0.0",
  author: "Ohiyo",
  transformMessage: (msg) => {
    if (!/<t:\d+/.test(msg.content)) return msg;
    const content = msg.content.replace(/<t:(\d+)(:R)?>/g, (_m, ts, rel) => {
      const date = new Date(parseInt(ts) * 1000);
      if (rel) {
        const diff = Math.round((Date.now() - date.getTime()) / 1000);
        const abs = Math.abs(diff);
        const past = diff >= 0;
        if (abs < 60) return past ? "just now" : "in a moment";
        if (abs < 3600) return `${past ? "" : "in "}${Math.round(abs / 60)}m${past ? " ago" : ""}`;
        if (abs < 86400) return `${past ? "" : "in "}${Math.round(abs / 3600)}h${past ? " ago" : ""}`;
        return `${past ? "" : "in "}${Math.round(abs / 86400)}d${past ? " ago" : ""}`;
      }
      return date.toLocaleString();
    });
    return { ...msg, content };
  },
};

export const BUILTIN_PLUGINS: OhiyoPlugin[] = [
  compactModePlugin,
  customCssPlugin,
  mentionHighlightPlugin,
  linkPreviewPlugin,
  codeHighlightPlugin,
  messageSoundPlugin,
  keyboardNavPlugin,
  zenModePlugin,
  fontPickerPlugin,
  spoilerPlugin,
  chatCommandsPlugin,
  bigEmojiPlugin,
  timestampPlugin,
];

// ── Plugin Manager ────────────────────────────────────────────────────────────

const ENABLED_KEY = "kikkacord:plugins:enabled";

export class PluginManager {
  private loaded = new Map<string, OhiyoPlugin>();
  private styleElements = new Map<string, HTMLStyleElement>();
  private eventHandlers = new Map<string, Set<PluginEventHandler>>();
  // Worker sandboxes for untrusted (user-installed) plugins, keyed by plugin id.
  private sandboxes = new Map<string, SandboxHost>();
  private api: PluginAPI;
  private plugins: OhiyoPlugin[];

  constructor(api: PluginAPI, extraPlugins: OhiyoPlugin[] = []) {
    this.api = api;
    this.plugins = [...BUILTIN_PLUGINS, ...extraPlugins];
  }

  allPlugins(): OhiyoPlugin[] {
    return this.plugins;
  }

  enabledIds(): string[] {
    try {
      return JSON.parse(localStorage.getItem(ENABLED_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  isEnabled(id: string): boolean {
    return this.enabledIds().includes(id);
  }

  enable(id: string) {
    const ids = [...new Set([...this.enabledIds(), id])];
    localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));
    this.load(id);
  }

  disable(id: string) {
    const ids = this.enabledIds().filter((x) => x !== id);
    localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));
    this.unload(id);
  }

  loadEnabled() {
    for (const id of this.enabledIds()) {
      this.load(id);
    }
  }

  load(id: string) {
    if (this.loaded.has(id)) return;
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;

    const host = this.sandboxes.get(id);
    if (host) {
      // Sandboxed plugin: run onLoad inside the worker; no in-page API handed out.
      host.start();
    } else {
      const pluginApi = this.buildPluginApi(id);
      plugin.onLoad?.(pluginApi);
    }

    if (plugin.css) {
      const el = injectStyle(`plugin-${id}`, plugin.css);
      this.styleElements.set(id, el);
    }

    this.loaded.set(id, plugin);
  }

  unload(id: string) {
    const plugin = this.loaded.get(id);
    if (!plugin) return;

    const host = this.sandboxes.get(id);
    if (host) host.terminate();
    else plugin.onUnload?.();
    this.styleElements.get(id)?.remove();
    this.styleElements.delete(id);
    this.loaded.delete(id);
  }

  // Apply transformMessage pipeline from all active plugins.
  applyMessageTransforms(msg: Message): Message | null {
    let current: Message | null = msg;
    for (const plugin of this.loaded.values()) {
      if (!current) break;
      if (plugin.transformMessage) {
        try {
          current = plugin.transformMessage(current);
        } catch {
          // A throwing plugin must not crash the render path — skip its transform.
        }
      }
    }
    return current;
  }

  // Apply transformSend pipeline.
  applyTransformSend(text: string): string {
    let current = text;
    for (const plugin of this.loaded.values()) {
      if (plugin.transformSend) {
        try {
          current = plugin.transformSend(current);
        } catch {
          // A throwing plugin must not block sending — skip its transform.
        }
      }
    }
    return current;
  }

  // The persisted user-plugin list. Stored as `{ id, url }[]` so uninstall can
  // look up by plugin id rather than fragile array-index alignment. Reads the
  // legacy `string[]` shape transparently (id is unknown until first reload).
  private userPluginEntries(): UserPluginEntry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(localStorage.getItem("kikkacord:user-plugin-urls") ?? "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item): UserPluginEntry | null => {
        if (typeof item === "string") return { url: item }; // legacy shape
        if (item && typeof item === "object" && typeof (item as UserPluginEntry).url === "string") {
          const e = item as UserPluginEntry;
          return typeof e.id === "string" ? { id: e.id, url: e.url } : { url: e.url };
        }
        return null;
      })
      .filter((e): e is UserPluginEntry => e !== null);
  }

  private saveUserPluginEntries(entries: UserPluginEntry[]) {
    localStorage.setItem("kikkacord:user-plugin-urls", JSON.stringify(entries));
  }

  userPluginUrls(): string[] {
    return this.userPluginEntries().map((e) => e.url);
  }

  async installFromUrl(url: string): Promise<string> {
    let resolved: URL;
    try {
      resolved = new URL(url, location.href);
    } catch {
      throw new Error("Invalid plugin URL");
    }
    // Fetch the source as text. Same-origin always works; cross-origin requires
    // the host to send permissive CORS headers (most raw/CDN hosts do).
    let source: string;
    try {
      source = await fetch(resolved.href).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    } catch (e) {
      throw new Error(`Couldn't fetch plugin (the host must allow cross-origin requests): ${(e as Error).message}`);
    }

    // SECURITY: untrusted code runs in an isolated Worker — no DOM, no auth
    // token, no network — so arbitrary remote plugins are safe to install.
    const host = new SandboxHost(source, {
      onToast: (text, type) => this.api.toast(text, type as "info" | "success" | "error" | "warn"),
      onError: (msg) => console.warn("[plugin:sandbox] error:", msg),
    });
    let manifest;
    try {
      manifest = await host.ready();
    } catch (e) {
      host.terminate();
      throw new Error(`Invalid plugin: ${(e as Error).message}`);
    }
    // Defense-in-depth: the worker bootstrap already allowlists the id, but the
    // host must not trust a manifest that arrives over postMessage — the id is
    // used as a localStorage key prefix (`plugin:<id>:`) so an out-of-allowlist
    // id could collide with another plugin's store.
    if (!isValidPluginId(manifest.id)) {
      host.terminate();
      throw new Error(`Invalid plugin id "${manifest.id}" (must match ^[A-Za-z0-9._-]+$)`);
    }
    if (this.plugins.some((p) => p.id === manifest.id)) {
      host.terminate();
      throw new Error(`Plugin "${manifest.id}" already installed`);
    }
    host.bindStore(this.makeStore(manifest.id));
    this.sandboxes.set(manifest.id, host);

    const plugin: OhiyoPlugin = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      author: manifest.author,
      css: sanitizePluginCss(manifest.css),
    };
    this.plugins.push(plugin);
    const entries = this.userPluginEntries();
    const existing = entries.find((e) => e.url === url);
    if (!existing) {
      this.saveUserPluginEntries([...entries, { id: manifest.id, url }]);
    } else if (existing.id !== manifest.id) {
      // Backfill the id onto a legacy/url-only entry now that we know it.
      this.saveUserPluginEntries(
        entries.map((e) => (e.url === url ? { id: manifest.id, url } : e)),
      );
    }
    return manifest.id;
  }

  async loadUserPlugins() {
    for (const url of this.userPluginUrls()) {
      try {
        await this.installFromUrl(url);
      } catch {
        // skip broken user plugins on reload
      }
    }
  }

  uninstallUserPlugin(pluginId: string) {
    this.unload(pluginId);
    this.sandboxes.get(pluginId)?.terminate();
    this.sandboxes.delete(pluginId);
    this.plugins = this.plugins.filter((p) => p.id !== pluginId);
    // Drop the persisted entry by id. Legacy url-only entries (no id yet) are
    // kept; they get their id backfilled on the next successful reload/install.
    const remaining = this.userPluginEntries().filter((e) => e.id !== pluginId);
    this.saveUserPluginEntries(remaining);
  }

  isUserPlugin(id: string): boolean {
    return !BUILTIN_PLUGINS.some((p) => p.id === id) && this.plugins.some((p) => p.id === id);
  }

  // Emit an event to all active plugins: in-page subscribers AND sandboxes.
  emit(event: PluginEventName, data: unknown) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        try {
          h(data);
        } catch {
          // ignore plugin errors
        }
      }
    }
    // Forward (sanitized, inside dispatch) to every loaded sandbox.
    for (const id of this.loaded.keys()) {
      this.sandboxes.get(id)?.dispatch(event, data);
    }
  }

  // Namespaced persistent store for a plugin (shared by in-page API + sandbox RPC).
  private makeStore(id: string) {
    const prefix = `plugin:${id}:`;
    return {
      get: <T>(key: string): T | null => {
        try {
          const raw = localStorage.getItem(prefix + key);
          return raw ? (JSON.parse(raw) as T) : null;
        } catch {
          return null;
        }
      },
      set: (key: string, value: unknown) => {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      },
      del: (key: string) => {
        localStorage.removeItem(prefix + key);
      },
    };
  }

  private buildPluginApi(id: string): PluginAPI {
    return {
      ...this.api,
      store: this.makeStore(id),
      on: (event, handler) => {
        if (!this.eventHandlers.has(event)) {
          this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event)!.add(handler);
        return () => this.eventHandlers.get(event)?.delete(handler);
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLUGIN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** A plugin id becomes a localStorage key prefix; restrict it to safe chars. */
function isValidPluginId(id: unknown): id is string {
  return typeof id === "string" && PLUGIN_ID_RE.test(id);
}

function injectStyle(id: string, css: string): HTMLStyleElement {
  document.getElementById(id)?.remove();
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

function playTick() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // audio not available
  }
}

function handleKeyNav(e: KeyboardEvent) {
  if (e.altKey && e.key >= "1" && e.key <= "9") {
    window.dispatchEvent(new CustomEvent("kikkacord:jump-server", { detail: parseInt(e.key) - 1 }));
  }
  if (e.ctrlKey && e.key === "k") {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("kikkacord:open-search"));
  }
}

// Global user ref for mention plugin
declare global {
  interface Window {
    __kikkacordUser: { id: string; username: string; display_name: string; avatar_url: string | null } | null | undefined;
  }
}
