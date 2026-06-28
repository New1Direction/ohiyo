import { DEFAULT_HOME_URL, normalizeHomeUrl } from "./lib/homes";

// ── Runtime endpoint config ──────────────────────────────────────────────────
// The packaged app has a default home baked in, but the active home can switch at
// runtime (Instant Servers / self-hosts). All request helpers read this mutable origin.
let serverOrigin = DEFAULT_HOME_URL;

export function setServerOrigin(origin: string): string {
  serverOrigin = normalizeHomeUrl(origin);
  return serverOrigin;
}

export function getServerOrigin(): string {
  return serverOrigin;
}

export function getApiBase(): string {
  return `${serverOrigin}/api/v1`;
}

/** Base for serving uploaded files/avatars/emoji (`${getFileBase()}/files/{id}`). */
export function getFileBase(): string {
  return serverOrigin;
}

/** Gateway URL — uses a short-lived one-time ticket, not the long-lived JWT. */
export function gatewayUrl(ticket: string): string {
  const wsOrigin = serverOrigin.replace(/^http/, "ws");
  return `${wsOrigin}/gateway?ticket=${encodeURIComponent(ticket)}`;
}

export type PublicUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

export type Server = {
  id: string;
  name: string;
  owner_id: string;
  icon_url: string | null;
  created_at: number;
};

export type Channel = {
  id: string;
  server_id: string | null;
  name: string;
  channel_type: "text" | "voice" | "dm" | "group_dm";
  position: number;
  topic: string | null;
  created_at: number;
  category_id?: string | null;
  /** Disappearing-message TTL in seconds; null/undefined = off. */
  disappearing_seconds?: number | null;
  /** Group-DM membership generation; bumped on every add/remove so clients rotate
   *  their sender keys. 0/undefined for non-group channels. */
  epoch?: number;
  /** Group-DM owner (creator); only they may remove other members. */
  owner_id?: string | null;
  /** Imported Discord archive channel; stored as plaintext and visibly marked not E2E. */
  imported?: boolean;
};

export type Category = {
  id: string;
  server_id: string;
  name: string;
  position: number;
  created_at: number;
};

export type ServerWithChannels = Server & {
  channels: Channel[];
  members: PublicUser[];
  categories?: Category[];
};

export type ReactionGroup = {
  emoji: string;
  count: number;
  me: boolean;
};

export type AttachmentMeta = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Pixel dimensions for images, so the client reserves space before load (no shift). */
  width?: number | null;
  height?: number | null;
  /**
   * Server-emitted relative file URL, signed (`/files/<id>?s=<sig>`) when the server
   * has signed-file enforcement available. Prefer this over rebuilding from `id` so the
   * URL validates under `OHIYO_REQUIRE_SIGNED_FILES`. Absent on attachments stored by
   * older servers — callers fall back to `/files/<id>`.
   */
  url?: string;
  /** Present only after decrypting an E2EE message carrying a private attachment. */
  encrypted?: {
    alg: "AES-256-GCM";
    key: string;
    iv: string;
    cipher_size_bytes: number;
  };
};

export type ReplyPreview = {
  id: string;
  author: string;
  content: string;
};

export type PollOption = { id: string; text: string; votes: number; me: boolean };
export type Poll = {
  question: string;
  multi: boolean;
  closes_at: number | null;
  total_votes: number;
  options: PollOption[];
};

/** A resolved link-preview card, built server-side and delivered via MessageUpdate. */
export type Embed = {
  url: string;
  embed_type?: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  favicon: string | null;
  color?: string | null;
};

export type Message = {
  id: string;
  channel_id: string;
  author: PublicUser;
  content: string;
  created_at: number;
  edited_at: number | null;
  attachments?: AttachmentMeta[] | null;
  reactions?: ReactionGroup[];
  reply_to?: ReplyPreview | null;
  pinned?: boolean;
  poll?: Poll | null;
  embeds?: Embed[] | null;
  /** Unix time this message self-destructs (disappearing messages); null = never. */
  expires_at?: number | null;
  /** Client-only optimistic-send lifecycle (never returned by the server). */
  _state?: "pending" | "failed";
  /** Client-only: this message was decrypted from an E2E ciphertext for display. */
  _encrypted?: boolean;
  /** Client-only: E2E ciphertext exists, but this device lacks the key/plaintext cache. */
  _decryptState?: "unknown" | "not_covered" | "restore_failed";
  _send?: { content: string; attachmentIds?: string[]; replyTo?: string | null; encryptedAttachments?: AttachmentMeta[] };
};

/** One participant's read cursor in a channel (drives Delivered/Seen receipts). */
export type ReadCursor = {
  user_id: string;
  last_read_message_id: string | null;
  last_read_at: number;
};

export type ServerEmoji = {
  id: string;
  server_id: string;
  name: string;
  url: string;
  created_by: string;
  created_at: number;
};

export type FriendshipStatus = "self" | "none" | "pending_outgoing" | "pending_incoming" | "friends";

export type FriendItem = {
  user: PublicUser;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing" | null;
  updated_at: number;
};

export type PrivateDmLinkInfo = {
  token: string;
  expires_at: number;
};

export type PrivateDmLinkPreview = {
  creator: PublicUser;
  created_at: number;
  expires_at: number;
};

export type PrivateDmLinkRedeemed = {
  channel: Channel;
  creator: PublicUser;
};

export type ProfileTheme = {
  vibe?: "sunset" | "ocean" | "forest" | "grape" | "mono" | "custom";
  accent?: string;
  pattern?: "none" | "stars" | "hearts" | "bubbles";
  glow?: boolean;
  emoji?: string | null;
  showStatus?: boolean;
  showBio?: boolean;
  showActive?: boolean;
  showSongs?: boolean;
  showSocials?: boolean;
};

export type ProfileSong = {
  title: string;
  artist?: string | null;
  url?: string | null;
};

export type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  pronouns: string | null;
  banner_color: string | null;
  banner_url: string | null;
  custom_status: string | null;
  avatar_url: string | null;
  profile_theme: ProfileTheme | null;
  top_songs: ProfileSong[];
  last_active_at: number | null;
  social_spotify: string | null;
  social_github: string | null;
  social_twitter: string | null;
  social_steam: string | null;
  social_youtube: string | null;
  social_twitch: string | null;
};

export type AuthResponse = {
  token: string;
  user: PublicUser;
};

export type EventInfo = {
  id: string;
  server_id: string;
  title: string;
  description: string | null;
  starts_at: number;
  created_by: string;
  rsvp_count: number;
  me_rsvp: boolean;
};

export type Role = {
  id: string;
  server_id: string;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
  created_at: number;
};

export type InviteInfo = {
  code: string;
  server_id: string;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
};

export type InvitePreview = {
  code: string;
  server_id: string;
  server_name: string;
  icon_url: string | null;
  member_count: number;
  already_member: boolean;
};

export type ImportHistoryWindow = "All" | "Last90Days";

export type DiscrawlImportCapability = {
  enabled: boolean;
  managed_enabled: boolean;
  mode: "managed_discord_connect" | "local_discrawl_archive" | string;
  message: string;
};

export type DiscordConnectInfo = {
  managed_enabled: boolean;
  invite_url: string | null;
  message: string;
};

export type DiscordGuildInfo = {
  id: string;
  name: string;
  icon_url: string | null;
};

export type DiscrawlArchiveUploadResponse = {
  db_path: string;
  filename: string;
  size_bytes: number;
};

export type DiscrawlImportRequest = {
  db_path: string;
  media_root?: string | null;
  guild_id?: string | null;
  history?: ImportHistoryWindow | null;
};

export type DiscrawlPreview = {
  guild_id: string;
  guild_name: string;
  categories: number;
  channels: number;
  voice_channels: number;
  threads: number;
  authors: number;
  messages: number;
  attachments: number;
  downloaded_attachments: number;
};

export type ImportReport = {
  categories: number;
  channels: number;
  authors: number;
  messages: number;
  reactions: number;
  attachments: number;
  /** Custom emoji assets imported from a Discord template/archive when available. */
  emojis?: number;
  /** Granular Discord channel permission overwrites preserved for review/replay. */
  permission_overwrites?: number;
  roles_needing_review: string[];
  parked: string[];
};

export type DiscrawlImportResponse = {
  server: ServerWithChannels;
  report: ImportReport;
};

export type DiscordPermissionOverwriteReview = {
  channel_discord_id: string;
  channel_name: string;
  target_discord_id: string;
  target_type: "role" | "member" | "unknown" | string;
  target_name: string | null;
  allow: string;
  deny: string;
  allow_flags: string[];
  deny_flags: string[];
  manual_review: boolean;
  review_reason: string;
  verdict_title: string;
  verdict_summary: string;
  admin_action: string;
  risk_level: "ok" | "check" | "sensitive" | string;
};

export type DiscordImportAssetReview = {
  asset_type: string;
  discord_id: string;
  name: string | null;
  ohiyo_id: string | null;
  source_url: string | null;
  status: string;
  note: string | null;
};

export type DiscordImportReview = {
  server_id: string;
  import_id: string;
  guild_id: string;
  status: string;
  manual_review_count: number;
  overwrites: DiscordPermissionOverwriteReview[];
  assets: DiscordImportAssetReview[];
  checklist: string[];
};

export type ManagedDiscordImportJob = {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  message: string;
  result: DiscrawlImportResponse | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/** A provisioned Instant-Server instance (control-plane view). */
export interface HostedInstance {
  id: string;
  owner_id: string;
  name: string;
  subdomain: string;
  region: string;
  tier: string;
  status: "requested" | "provisioning" | "healthy" | "sleeping" | "waking" | "failed" | "suspended";
  machine_id?: string | null;
  volume_id?: string | null;
  public_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type SelfHostGuide = {
  docker_image: string;
  export_url: string;
  one_liner: string;
  steps: string[];
};

export type InstanceExport = {
  version: number;
  generated_at: number;
  instance: HostedInstance;
  data_note: string;
  self_host: SelfHostGuide;
  billing_note: string;
};

export type BillingCheckout = {
  mode: "operator" | "checkout" | string;
  checkout_url: string;
  note: string;
};

export type PushConfig = {
  enabled: boolean;
  vapid_public_key: string | null;
  privacy_note: string;
};

export type PushDevice = {
  id: string;
  user_id: string;
  platform: "web" | "apns" | "fcm" | string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  device_name: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type RegisterPushDeviceBody = {
  platform: "web" | "apns" | "fcm";
  endpoint: string;
  p256dh?: string | null;
  auth?: string | null;
  device_name?: string | null;
};

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  /** Exchange the JWT for a one-time gateway ticket (used to open the WebSocket). */
  getWsTicket: (token: string) =>
    request<{ ticket: string }>("/ws/ticket", { method: "POST" }, token).then((r) => r.ticket),

  register: (username: string, password: string, displayName?: string) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, display_name: displayName }),
    }),

  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  // Device linking (QR / one-time code). The primary mints a code; a new device redeems
  // it for a session token without the password.
  startDeviceLink: (token: string) =>
    request<{ code: string; expires_at: number }>("/devices/link/start", { method: "POST" }, token),
  completeDeviceLink: (code: string) =>
    request<AuthResponse>("/devices/link/complete", { method: "POST", body: JSON.stringify({ code }) }),

  me: (token: string) => request<PublicUser>("/users/@me", {}, token),

  // Content-free push relay registration. Payloads carry no message text/channel names.
  getPushConfig: () => request<PushConfig>("/push/config"),
  listPushDevices: (token: string) => request<PushDevice[]>("/push/devices", {}, token),
  registerPushDevice: (token: string, body: RegisterPushDeviceBody) =>
    request<PushDevice>("/push/devices", { method: "PUT", body: JSON.stringify(body) }, token),
  deletePushDevice: (token: string, id: string) =>
    request<void>(`/push/devices/${id}`, { method: "DELETE" }, token),

  // Instant Servers (control plane) — provision/list/status of your own server instances.
  // The client can now switch to a provisioned instance at runtime; these bindings
  // talk to the currently active control-plane home.
  createInstance: (name: string, token: string) =>
    request<HostedInstance>(
      "/instances",
      { method: "POST", body: JSON.stringify({ name }) },
      token
    ),
  listInstances: (token: string) => request<HostedInstance[]>("/instances", {}, token),
  getInstance: (id: string, token: string) =>
    request<HostedInstance>(`/instances/${id}`, {}, token),
  sleepInstance: (id: string, token: string) =>
    request<HostedInstance>(`/instances/${id}/sleep`, { method: "POST" }, token),
  wakeInstance: (id: string, token: string) =>
    request<HostedInstance>(`/instances/${id}/wake`, { method: "POST" }, token),
  setInstanceTier: (id: string, tier: "free" | "paid", token: string) =>
    request<HostedInstance>(`/instances/${id}/tier`, { method: "PATCH", body: JSON.stringify({ tier }) }, token),
  getInstanceExport: (id: string, token: string) =>
    request<InstanceExport>(`/instances/${id}/export`, {}, token),
  getGraduateGuide: (id: string, token: string) =>
    request<SelfHostGuide>(`/instances/${id}/graduate`, {}, token),
  getBillingCheckout: (id: string, token: string) =>
    request<BillingCheckout>(`/instances/${id}/billing`, {}, token),
  deleteInstance: (id: string, token: string) =>
    request<void>(`/instances/${id}`, { method: "DELETE" }, token),

  // Discord import — local/admin Discrawl archive path, gated server-side by
  // OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT=1.
  getDiscrawlImportCapability: (token: string) =>
    request<DiscrawlImportCapability>("/imports/discord/capability", {}, token),
  getDiscordConnectInfo: (token: string) =>
    request<DiscordConnectInfo>("/imports/discord/connect", {}, token),
  listDiscordImportGuilds: (token: string) =>
    request<DiscordGuildInfo[]>("/imports/discord/guilds", {}, token),
  runManagedDiscordImport: (token: string, guildId: string, history?: ImportHistoryWindow | null) =>
    request<DiscrawlImportResponse>(
      "/imports/discord/managed/run",
      { method: "POST", body: JSON.stringify({ guild_id: guildId, history: history ?? null }) },
      token
    ),
  startManagedDiscordImportJob: (token: string, guildId: string, history?: ImportHistoryWindow | null) =>
    request<{ job: ManagedDiscordImportJob }>(
      "/imports/discord/managed/jobs",
      { method: "POST", body: JSON.stringify({ guild_id: guildId, history: history ?? null }) },
      token
    ),
  getManagedDiscordImportJob: (token: string, jobId: string) =>
    request<ManagedDiscordImportJob>(`/imports/discord/managed/jobs/${jobId}`, {}, token),
  uploadDiscrawlArchive: async (token: string, file: File) => {
    const form = new FormData();
    form.append("archive", file);
    const res = await fetch(`${getApiBase()}/imports/discord/archive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json() as Promise<DiscrawlArchiveUploadResponse>;
  },
  previewDiscrawlImport: (token: string, body: DiscrawlImportRequest) =>
    request<DiscrawlPreview>(
      "/imports/discord/preview",
      { method: "POST", body: JSON.stringify(body) },
      token
    ),
  runDiscrawlImport: (token: string, body: DiscrawlImportRequest) =>
    request<DiscrawlImportResponse>(
      "/imports/discord/run",
      { method: "POST", body: JSON.stringify(body) },
      token
    ),
  runDiscordTemplateImport: (token: string, template: string) =>
    request<DiscrawlImportResponse>(
      "/imports/discord/template",
      { method: "POST", body: JSON.stringify({ template }) },
      token
    ),
  getDiscordImportReview: (token: string, serverId: string) =>
    request<DiscordImportReview>(`/imports/discord/servers/${serverId}/review`, {}, token),

  // Dead-man's switch (account-level inactivity wipe).
  getDeadman: (token: string) =>
    request<{ seconds: number | null; scope: string }>("/users/@me/deadman", {}, token),
  setDeadman: (token: string, seconds: number | null, scope: "history" | "keys") =>
    request<void>(
      "/users/@me/deadman",
      { method: "POST", body: JSON.stringify({ seconds, scope }) },
      token
    ),

  // User preferences (a single JSON blob per user) — used to sync appearance across
  // devices. POST replaces the whole blob, so callers merge before writing.
  getPrefs: (token: string) => request<Record<string, unknown>>("/users/@me/prefs", {}, token),
  setPrefs: (token: string, prefs: Record<string, unknown>) =>
    request<void>("/users/@me/prefs", { method: "POST", body: JSON.stringify(prefs) }, token),

  // Encrypted E2E key backup (recovery-code model). Server stores ciphertext only;
  // getKeyBackup rejects with a 404 when none exists.
  getKeyBackup: (token: string) => request<Record<string, unknown>>("/users/@me/key-backup", {}, token),
  putKeyBackup: (token: string, blob: Record<string, unknown>) =>
    request<void>("/users/@me/key-backup", { method: "PUT", body: JSON.stringify(blob) }, token),
  deleteKeyBackup: (token: string) =>
    request<void>("/users/@me/key-backup", { method: "DELETE" }, token),

  listServers: (token: string) =>
    request<ServerWithChannels[]>("/servers", {}, token),

  createServer: (token: string, name: string) =>
    request<ServerWithChannels>("/servers", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, token),

  joinServer: (token: string, serverId: string) =>
    request<ServerWithChannels>(`/servers/${serverId}/join`, {
      method: "POST",
    }, token),

  setServerIcon: (token: string, serverId: string, fileId: string) =>
    request<ServerWithChannels>(`/servers/${serverId}/icon`, {
      method: "POST",
      body: JSON.stringify({ file_id: fileId }),
    }, token),

  kickMember: (token: string, serverId: string, userId: string) =>
    request<void>(`/servers/${serverId}/members/${userId}`, { method: "DELETE" }, token),

  banMember: (token: string, serverId: string, userId: string) =>
    request<void>(`/servers/${serverId}/bans/${userId}`, { method: "POST" }, token),

  // ── Roles & permissions ───────────────────────────────────────────────────
  getMyPermissions: (token: string, serverId: string) =>
    request<{ permissions: number }>(`/servers/${serverId}/me/permissions`, {}, token),

  listRoles: (token: string, serverId: string) =>
    request<Role[]>(`/servers/${serverId}/roles`, {}, token),

  createRole: (token: string, serverId: string, name: string, permissions: number, color?: string | null) =>
    request<Role>(`/servers/${serverId}/roles`, {
      method: "POST",
      body: JSON.stringify({ name, permissions, color: color ?? null }),
    }, token),

  deleteRole: (token: string, serverId: string, roleId: string) =>
    request<void>(`/servers/${serverId}/roles/${roleId}`, { method: "DELETE" }, token),

  getMemberRoles: (token: string, serverId: string, userId: string) =>
    request<string[]>(`/servers/${serverId}/members/${userId}/roles`, {}, token),

  assignRole: (token: string, serverId: string, userId: string, roleId: string) =>
    request<void>(`/servers/${serverId}/members/${userId}/roles/${roleId}`, { method: "PUT" }, token),

  unassignRole: (token: string, serverId: string, userId: string, roleId: string) =>
    request<void>(`/servers/${serverId}/members/${userId}/roles/${roleId}`, { method: "DELETE" }, token),

  searchMessages: (token: string, serverId: string, q: string) =>
    request<Message[]>(`/servers/${serverId}/search?q=${encodeURIComponent(q)}`, {}, token),

  // ── Scheduled events ──────────────────────────────────────────────────────
  listEvents: (token: string, serverId: string) =>
    request<EventInfo[]>(`/servers/${serverId}/events`, {}, token),

  createEvent: (token: string, serverId: string, title: string, startsAt: number, description?: string | null) =>
    request<void>(`/servers/${serverId}/events`, {
      method: "POST",
      body: JSON.stringify({ title, starts_at: startsAt, description: description ?? null }),
    }, token),

  rsvpEvent: (token: string, serverId: string, eventId: string) =>
    request<void>(`/servers/${serverId}/events/${eventId}/rsvp`, { method: "POST" }, token),

  deleteEvent: (token: string, serverId: string, eventId: string) =>
    request<void>(`/servers/${serverId}/events/${eventId}`, { method: "DELETE" }, token),

  createChannel: (token: string, serverId: string, name: string, categoryId?: string | null) =>
    request<Channel>(`/servers/${serverId}/channels`, {
      method: "POST",
      body: JSON.stringify({ name, category_id: categoryId ?? null }),
    }, token),

  createCategory: (token: string, serverId: string, name: string) =>
    request<Category>(`/servers/${serverId}/categories`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }, token),

  deleteCategory: (token: string, serverId: string, categoryId: string) =>
    request<void>(`/servers/${serverId}/categories/${categoryId}`, { method: "DELETE" }, token),

  moveChannel: (token: string, serverId: string, channelId: string, categoryId: string | null) =>
    request<void>(`/servers/${serverId}/channels/${channelId}/category`, {
      method: "PUT",
      body: JSON.stringify({ category_id: categoryId }),
    }, token),

  listMessages: (token: string, channelId: string) =>
    request<Message[]>(`/channels/${channelId}/messages`, {}, token),

  /** Read cursors for a channel — hydrates Delivered/Seen receipts on open. */
  listReads: (token: string, channelId: string) =>
    request<ReadCursor[]>(`/channels/${channelId}/reads`, {}, token),

  // Disappearing messages: set the channel TTL in seconds (0/null turns it off).
  setDisappearing: (token: string, channelId: string, seconds: number | null) =>
    request<void>(
      `/channels/${channelId}/disappearing`,
      { method: "PATCH", body: JSON.stringify({ seconds }) },
      token
    ),

  sendMessage: (
    token: string,
    channelId: string,
    content: string,
    attachmentIds?: string[],
    replyTo?: string | null
  ) =>
    request<Message>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        attachment_ids: attachmentIds ?? [],
        reply_to: replyTo ?? null,
      }),
    }, token),

  editMessage: (token: string, channelId: string, messageId: string, content: string) =>
    request<Message>(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }, token),

  deleteMessage: (token: string, channelId: string, messageId: string) =>
    request<void>(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }, token),

  pinMessage: (token: string, channelId: string, messageId: string) =>
    request<Message>(`/channels/${channelId}/messages/${messageId}/pin`, { method: "POST" }, token),

  unpinMessage: (token: string, channelId: string, messageId: string) =>
    request<Message>(`/channels/${channelId}/messages/${messageId}/pin`, { method: "DELETE" }, token),

  listPins: (token: string, channelId: string) =>
    request<Message[]>(`/channels/${channelId}/pins`, {}, token),

  saveMessage: (token: string, channelId: string, messageId: string) =>
    request<void>(`/channels/${channelId}/messages/${messageId}/save`, { method: "POST" }, token),

  unsaveMessage: (token: string, channelId: string, messageId: string) =>
    request<void>(`/channels/${channelId}/messages/${messageId}/save`, { method: "DELETE" }, token),

  listSaved: (token: string) => request<Message[]>("/users/@me/saved", {}, token),

  createPoll: (
    token: string,
    channelId: string,
    question: string,
    options: string[],
    opts?: { multi?: boolean; closesInSecs?: number | null }
  ) =>
    request<Message>(`/channels/${channelId}/polls`, {
      method: "POST",
      body: JSON.stringify({
        question,
        options,
        multi: opts?.multi ?? false,
        closes_in_secs: opts?.closesInSecs ?? null,
      }),
    }, token),

  votePoll: (token: string, channelId: string, messageId: string, optionId: string) =>
    request<Message>(`/channels/${channelId}/polls/${messageId}/vote`, {
      method: "POST",
      body: JSON.stringify({ option_id: optionId }),
    }, token),

  react: (token: string, channelId: string, messageId: string, emoji: string) =>
    request<void>(`/channels/${channelId}/messages/${messageId}/react/${emoji}`, {
      method: "POST",
    }, token),

  getPublicProfile: (token: string, userId: string) =>
    request<UserProfile>(`/users/${userId}/profile`, {}, token),

  listFriends: (token: string) => request<FriendItem[]>("/users/@me/friends", {}, token),
  getFriendship: (token: string, userId: string) =>
    request<{ status: FriendshipStatus }>(`/users/${userId}/friendship`, {}, token),
  sendFriendRequest: (token: string, userId: string) =>
    request<{ status: FriendshipStatus }>(`/users/${userId}/friend-request`, { method: "POST" }, token),
  acceptFriendRequest: (token: string, userId: string) =>
    request<{ status: FriendshipStatus }>(`/users/${userId}/friend-request/accept`, { method: "POST" }, token),
  deleteFriendship: (token: string, userId: string) =>
    request<void>(`/users/${userId}/friendship`, { method: "DELETE" }, token),

  getMyProfile: (token: string) =>
    request<UserProfile>("/users/@me/profile", {}, token),

  updateProfile: (
    token: string,
    patch: Partial<{
      display_name: string;
      bio: string;
      banner_color: string;
      custom_status: string;
      profile_theme?: ProfileTheme;
      top_songs?: ProfileSong[];
    }>
  ) =>
    request<UserProfile>("/users/@me/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }, token),

  listEmojis: (token: string, serverId: string) =>
    request<ServerEmoji[]>(`/servers/${serverId}/emojis`, {}, token),

  createEmoji: (token: string, serverId: string, name: string, fileId: string) =>
    request<ServerEmoji>(`/servers/${serverId}/emojis`, {
      method: "POST",
      body: JSON.stringify({ name, file_id: fileId }),
    }, token),

  deleteEmoji: (token: string, serverId: string, emojiId: string) =>
    request<void>(`/servers/${serverId}/emojis/${emojiId}`, { method: "DELETE" }, token),

  setAvatar: (token: string, fileId: string) =>
    request<PublicUser>("/users/@me/avatar", {
      method: "POST",
      body: JSON.stringify({ file_id: fileId }),
    }, token),

  setBanner: (token: string, fileId: string) =>
    request<void>("/users/@me/banner", {
      method: "POST",
      body: JSON.stringify({ file_id: fileId }),
    }, token),

  openDm: (token: string, recipientId: string) =>
    request<Channel>("/users/@me/dms", {
      method: "POST",
      body: JSON.stringify({ recipient_id: recipientId }),
    }, token),

  // Create a group DM with several people (group E2E layers on top of this channel).
  createGroupDm: (token: string, recipientIds: string[], name?: string) =>
    request<Channel>("/users/@me/group-dms", {
      method: "POST",
      body: JSON.stringify({ recipient_ids: recipientIds, name: name ?? null }),
    }, token),

  // Participants of a DM / group DM — used to fan out sender-key distributions.
  listRecipients: (token: string, channelId: string) =>
    request<PublicUser[]>(`/channels/${channelId}/recipients`, {}, token),

  // Add someone to a group DM (any member may add). Bumps the group's rekey epoch.
  addRecipient: (token: string, channelId: string, userId: string) =>
    request<void>(
      `/channels/${channelId}/recipients`,
      { method: "POST", body: JSON.stringify({ user_id: userId }) },
      token,
    ),

  // Remove a member (owner only) or leave the group (user_id === self). Bumps the
  // rekey epoch so the remaining members rotate their sender keys.
  removeRecipient: (token: string, channelId: string, userId: string) =>
    request<void>(`/channels/${channelId}/recipients/${userId}`, { method: "DELETE" }, token),

  // Relay encrypted Sender Key Distribution Messages to the group (group E2E bootstrap).
  distributeSenderKey: (token: string, channelId: string, envelopes: Record<string, string>) =>
    request<void>(
      `/channels/${channelId}/sender-key`,
      { method: "POST", body: JSON.stringify({ envelopes }) },
      token
    ),

  // Relay encrypted voice/video E2EE room-key envelopes to call participants. Server
  // forwards opaque ciphertext only; each recipient is membership-checked.
  distributeVoiceKey: (token: string, channelId: string, envelopes: Record<string, string>) =>
    request<void>(
      `/channels/${channelId}/voice-key`,
      { method: "POST", body: JSON.stringify({ envelopes }) },
      token
    ),

  /** Fetch STUN + time-limited TURN ICE servers for WebRTC. */
  getIceServers: (token: string) =>
    request<{ iceServers: RTCIceServer[]; ttlExpiresAt?: number }>("/ice-servers", {}, token),

  // LiveKit SFU (optional, feature-flagged) — config discovery + room join token.
  getLiveKitConfig: (token: string) =>
    request<{ enabled: boolean; url: string | null }>("/livekit/config", {}, token),
  getLiveKitToken: (token: string, channelId: string) =>
    request<{ token: string; url: string; room: string }>(
      `/channels/${channelId}/livekit-token`,
      { method: "POST" },
      token
    ),

  // Watch party — fetch the current synced video state for a channel (or null).
  getWatch: (token: string, channelId: string) =>
    request<{ url: string; paused: boolean; position: number; updated_at: number; host_id: string } | null>(
      `/channels/${channelId}/watch`,
      {},
      token
    ),

  // E2E encryption key directory — publish my device public key; fetch a peer's.
  publishKey: (token: string, publicKey: string) =>
    request<void>("/users/@me/key", { method: "POST", body: JSON.stringify({ public_key: publicKey }) }, token),
  getUserKey: (token: string, userId: string) =>
    request<{ public_key: string | null }>(`/users/${userId}/key`, {}, token),

  // Signal Protocol (X3DH) prekey directory.
  signalPublishKeys: (
    token: string,
    body: {
      device_id: number;
      identity_key: string;
      registration_id: number;
      signed_prekey: { key_id: number; public_key: string; signature: string };
      one_time_prekeys: { key_id: number; public_key: string }[];
    }
  ) => request<void>("/signal/keys", { method: "POST", body: JSON.stringify(body) }, token),
  // All of a user's devices' bundles — the sender fans out a copy to each.
  getPrekeyBundles: (token: string, userId: string) =>
    request<
      {
        device_id: number;
        identity_key: string;
        registration_id: number;
        signed_prekey: { key_id: number; public_key: string; signature: string };
        one_time_prekey: { key_id: number; public_key: string } | null;
      }[]
    >(`/users/${userId}/prekey-bundles`, {}, token),
  signalPrekeyCount: (token: string, deviceId: number) =>
    request<{ count: number }>(`/signal/keys/count?device_id=${deviceId}`, {}, token),

  // Every device's identity key for a user — no prekey consumption. For the full
  // multi-device safety number.
  getIdentityKeys: (token: string, userId: string) =>
    request<{ device_id: number; identity_key: string }[]>(`/users/${userId}/identity-keys`, {}, token),

  // This account's registered Signal devices (read-only; doesn't consume prekeys).
  listDevices: (token: string) =>
    request<{ device_id: number; updated_at: number }[]>("/users/@me/devices", {}, token),

  // Revoke a device from the directory (drop its identity + prekeys).
  removeDevice: (token: string, deviceId: number) =>
    request<void>(`/users/@me/devices/${deviceId}`, { method: "DELETE" }, token),

  // ── Invites & people ──────────────────────────────────────────────────────
  createInvite: (
    token: string,
    serverId: string,
    opts?: { maxUses?: number | null; expiresInSecs?: number | null }
  ) =>
    request<InviteInfo>(`/servers/${serverId}/invites`, {
      method: "POST",
      body: JSON.stringify({
        max_uses: opts?.maxUses ?? null,
        expires_in_secs: opts?.expiresInSecs ?? null,
      }),
    }, token),

  getInvite: (token: string, code: string) =>
    request<InvitePreview>(`/invites/${encodeURIComponent(code)}`, {}, token),

  redeemInvite: (token: string, code: string) =>
    request<ServerWithChannels>(`/invites/${encodeURIComponent(code)}`, { method: "POST" }, token),

  createPrivateDmLink: (token: string, expiresInSecs?: number | null) =>
    request<PrivateDmLinkInfo>("/users/@me/dm-links", {
      method: "POST",
      body: JSON.stringify({ expires_in_secs: expiresInSecs ?? null }),
    }, token),

  previewPrivateDmLink: (token: string, linkToken: string) =>
    request<PrivateDmLinkPreview>(`/dm-links/${encodeURIComponent(linkToken)}`, {}, token),

  redeemPrivateDmLink: (token: string, linkToken: string) =>
    request<PrivateDmLinkRedeemed>(`/dm-links/${encodeURIComponent(linkToken)}`, { method: "POST" }, token),

  revokePrivateDmLink: (token: string, linkToken: string) =>
    request<void>(`/dm-links/${encodeURIComponent(linkToken)}`, { method: "DELETE" }, token),

  searchUsers: (token: string, q: string) =>
    request<PublicUser[]>(`/users/search?q=${encodeURIComponent(q)}`, {}, token),
};

/** Build a shareable invite URL from a code (current origin + ?invite=). */
export function inviteUrl(code: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
}

/** Build a one-time private-DM URL from a bearer token. */
export function privateDmUrl(token: string): string {
  return `${window.location.origin}/?dm=${encodeURIComponent(token)}`;
}
