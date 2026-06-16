import type { Channel, Message, PublicUser, ServerWithChannels } from "../api";

// The public API surface exposed to plugins.
export type PluginAPI = {
  // App state (read-only snapshots)
  getUser: () => PublicUser | null;
  getServers: () => ServerWithChannels[];
  getCurrentChannel: () => Channel | null;
  getMessages: () => Message[];

  // Persistent per-plugin key/value store (localStorage namespaced)
  store: {
    get: <T>(key: string) => T | null;
    set: (key: string, value: unknown) => void;
    del: (key: string) => void;
  };

  // Notifications
  toast: (text: string, type?: "info" | "success" | "error" | "warn") => void;

  // Event bus (subset of gateway events)
  on: (event: PluginEventName, handler: PluginEventHandler) => () => void;
};

export type PluginEventName =
  | "message"
  | "channel-select"
  | "server-select"
  | "ready";

export type PluginEventHandler = (data: unknown) => void;

// What a plugin module must export as default.
export type OhiyoPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;

  // Called once when the plugin is loaded.
  onLoad?: (api: PluginAPI) => void;
  // Called once when the plugin is unloaded.
  onUnload?: () => void;

  // Optional UI extension points.
  // These are called by the host to collect React nodes.
  // We pass them as stable string keys and the host resolves them.

  // Transform message content before render (return null to suppress).
  transformMessage?: (msg: Message) => Message | null;

  // Transform message text before sending.
  transformSend?: (text: string) => string;

  // Extra CSS injected while the plugin is active.
  css?: string;
};
