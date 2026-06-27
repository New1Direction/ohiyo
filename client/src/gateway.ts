import type { PublicUser, ServerWithChannels, Channel, Message } from "./api";
import { gatewayUrl, api } from "./api";

/** A peer already present in a voice channel when you join. */
export type VoicePeer = {
  user_id: string;
  user: PublicUser;
  muted: boolean;
  video: boolean;
  screen: boolean;
  listenOnly?: boolean;
};

// ── Server → client events ─────────────────────────────────────────────────────
/** Rich presence — what a user is currently doing. */
export type Activity = { kind: string; name: string; details?: string | null };

/** A synced watch-party: shared video + playback state for a channel. */
export type WatchSession = {
  url: string;
  paused: boolean;
  position: number;
  updated_at: number;
  host_id: string;
};

export type GatewayEvent =
  | { t: "Ready"; d: { user: PublicUser; servers: ServerWithChannels[]; dms: Channel[]; unread?: Record<string, number> } }
  | { t: "MessageCreate"; d: Message }
  | { t: "MessageUpdate"; d: Message }
  | { t: "MessageDelete"; d: { id: string; channel_id: string } }
  | { t: "DisappearingUpdate"; d: { channel_id: string; seconds: number | null } }
  | { t: "SenderKeyDistribution"; d: { channel_id: string; from_user_id: string; envelope: string } }
  | { t: "GroupMembersUpdate"; d: { channel_id: string; epoch: number; participants: PublicUser[] } }
  | { t: "VoiceKeyDistribution"; d: { channel_id: string; from_user_id: string; envelope: string } }
  | { t: "ServerCreate"; d: ServerWithChannels }
  | { t: "ServerDelete"; d: { id: string } }
  | { t: "ChannelCreate"; d: Channel }
  | { t: "MemberJoin"; d: { server_id: string; user: PublicUser } }
  | { t: "MemberLeave"; d: { server_id: string; user_id: string } }
  | { t: "PermissionsUpdate"; d: { server_id: string } }
  | { t: "EventsChanged"; d: { server_id: string } }
  | { t: "ReactionUpdate"; d: { message_id: string; channel_id: string; emoji: string; user_id: string; added: boolean } }
  | { t: "ReadReceipt"; d: { channel_id: string; user_id: string; last_read_message_id: string; last_read_at: number } }
  | { t: "PresenceUpdate"; d: { user_id: string; online: boolean; status?: string; activity?: Activity | null } }
  | { t: "TypingStart"; d: { channel_id: string; user_id: string; user: PublicUser } }
  | { t: "VoiceState"; d: { channel_id: string; user_id: string; user: PublicUser; joined: boolean; muted: boolean; video: boolean; screen: boolean; listenOnly: boolean } }
  | { t: "VoiceRoster"; d: { channel_id: string; peers: VoicePeer[] } }
  | { t: "VoiceSignal"; d: { from: string; to: string; channel_id: string; kind: string; payload: string } }
  | { t: "WatchUpdate"; d: { channel_id: string; session: WatchSession | null } };

// ── Client → server events (mirror the server's ClientEvent enum) ──────────────
export type ClientEvent =
  | { t: "JoinVoice"; d: { channel_id: string; muted: boolean; video: boolean; listen_only: boolean } }
  | { t: "LeaveVoice"; d: { channel_id: string } }
  | { t: "VoiceMeta"; d: { channel_id: string; muted: boolean; video: boolean; screen: boolean; listen_only: boolean } }
  | { t: "Signal"; d: { to: string; channel_id: string; kind: string; payload: string } }
  | { t: "Typing"; d: { channel_id: string } }
  | { t: "Ack"; d: { channel_id: string; message_id: string } }
  | { t: "SetActivity"; d: { activity: Activity | null } }
  | { t: "SetPresence"; d: { idle: boolean } }
  | { t: "SetPrivacyMode"; d: { enabled: boolean } }
  | { t: "WatchControl"; d: { channel_id: string; action: string; url?: string | null; position?: number | null } }
  | { t: "Heartbeat" };

export type GatewayHandler = (event: GatewayEvent) => void;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type StatusHandler = (status: ConnectionStatus) => void;

const HEARTBEAT_MS = 20_000;
// A silently-dropped socket (mobile/NAT/sleep) emits no close event, so we watch the
// last-inbound-frame time on each heartbeat tick and force-close once we've been quiet
// for ~2 heartbeats — that triggers onclose → scheduleReconnect.
const DEAD_CONNECTION_MS = HEARTBEAT_MS * 2;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/** Every server→client event tag (the `t` discriminant). A frame whose `t` isn't one
 *  of these is well-formed JSON but the wrong shape, so we drop it before fan-out. */
const KNOWN_EVENT_TAGS: ReadonlySet<string> = new Set([
  "Ready", "MessageCreate", "MessageUpdate", "MessageDelete", "DisappearingUpdate",
  "SenderKeyDistribution", "GroupMembersUpdate", "VoiceKeyDistribution", "ServerCreate",
  "ServerDelete", "ChannelCreate", "MemberJoin", "MemberLeave", "PermissionsUpdate",
  "EventsChanged", "ReactionUpdate", "ReadReceipt", "PresenceUpdate", "TypingStart",
  "VoiceState", "VoiceRoster", "VoiceSignal", "WatchUpdate",
]);

export class Gateway {
  private ws: WebSocket | null = null;
  private handlers = new Set<GatewayHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private token: string;
  private attempts = 0;
  private closedByUser = false;
  private _status: ConnectionStatus = "disconnected";

  constructor(token: string) {
    this.token = token;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    if (this._status === status) return;
    this._status = status;
    for (const h of this.statusHandlers) h(status);
  }

  async connect() {
    this.closedByUser = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Detach + close any pre-existing socket so we never end up with two live sockets,
    // each running its own heartbeat and scheduling its own reconnects.
    this.detachSocket();
    this.setStatus("connecting");
    // Exchange the JWT for a one-time ticket so it never appears in the WS URL.
    let ticket: string;
    try {
      ticket = await api.getWsTicket(this.token);
    } catch {
      this.setStatus("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return; // disconnect() happened while fetching the ticket
    const ws = new WebSocket(gatewayUrl(ticket));
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastFrameAt = Date.now();
      this.setStatus("connected");
      this.startHeartbeat();
    };

    ws.onmessage = (e) => {
      this.lastFrameAt = Date.now();
      let event: GatewayEvent;
      try {
        event = JSON.parse(e.data) as GatewayEvent;
      } catch (err) {
        console.warn("[gateway] dropped malformed frame", err);
        return;
      }
      // Guard against a well-formed-but-wrong-shape payload reaching handlers that
      // read event.d.* — only fan out frames whose tag we recognize.
      if (typeof event?.t !== "string" || !KNOWN_EVENT_TAGS.has(event.t)) {
        console.warn("[gateway] dropped frame with unknown tag", (event as { t?: unknown })?.t);
        return;
      }
      for (const h of this.handlers) h(event);
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.setStatus("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  /** Null out the handlers on the current socket and close it. Detaching the handlers
   *  BEFORE closing keeps a soon-to-be-replaced socket from firing onclose →
   *  scheduleReconnect and racing the fresh connection. */
  private detachSocket() {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch { /* already closing/closed */ }
    this.ws = null;
  }

  /** Send a client→server event (signaling, voice state, heartbeat). */
  send(event: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Force a reconnect if the socket has gone silent (no inbound frame for ~2
      // heartbeats) — a silently-dropped connection never fires onclose on its own.
      if (this.lastFrameAt && Date.now() - this.lastFrameAt > DEAD_CONNECTION_MS) {
        console.warn("[gateway] no inbound frames; treating socket as dead");
        this.ws?.close(); // → onclose → scheduleReconnect
        return;
      }
      this.send({ t: "Heartbeat" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    // Clear any pending timer first — both onclose and the ticket-fetch catch can call
    // this, and we must never leave an orphaned timer that fires a second connect().
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Exponential backoff with jitter, capped.
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
    const jittered = delay * (0.7 + Math.random() * 0.3);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    // Null the handlers before closing so the detached socket's onclose can't fire and
    // schedule a reconnect after the user explicitly disconnected.
    this.detachSocket();
    this.setStatus("disconnected");
  }

  on(handler: GatewayHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    handler(this._status);
    return () => this.statusHandlers.delete(handler);
  }
}
