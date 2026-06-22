import type { PublicUser, ServerWithChannels, Channel, Message } from "./api";
import { gatewayUrl, api } from "./api";

/** A peer already present in a voice channel when you join. */
export type VoicePeer = {
  user_id: string;
  user: PublicUser;
  muted: boolean;
  video: boolean;
  screen: boolean;
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
  | { t: "WatchControl"; d: { channel_id: string; action: string; url?: string | null; position?: number | null } }
  | { t: "Heartbeat" };

export type GatewayHandler = (event: GatewayEvent) => void;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type StatusHandler = (status: ConnectionStatus) => void;

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export class Gateway {
  private ws: WebSocket | null = null;
  private handlers = new Set<GatewayHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
    this.ws = new WebSocket(gatewayUrl(ticket));

    this.ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("connected");
      this.startHeartbeat();
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as GatewayEvent;
        for (const h of this.handlers) h(event);
      } catch (err) {
        console.warn("[gateway] dropped malformed frame", err);
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.setStatus("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
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
    this.heartbeatTimer = setInterval(() => this.send({ t: "Heartbeat" }), HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    // Exponential backoff with jitter, capped.
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
    const jittered = delay * (0.7 + Math.random() * 0.3);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
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
