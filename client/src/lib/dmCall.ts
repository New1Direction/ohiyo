// Calls in DMs and group chats: the rings waiting for an answer, and what a call log in the
// chat says to each person.

export type CallLogState = "ringing" | "ongoing" | "ended" | "missed" | "declined";

/** The call log the server keeps on a DM message (`message.call`). */
export type CallLog = {
  state: CallLogState;
  video?: boolean;
  started_at?: number;
  answered_at?: number | null;
  ended_at?: number | null;
  duration_secs?: number | null;
  declined_by?: string | null;
};

/** A call ringing for you, from a `CallRing` gateway event. */
export type IncomingRing = {
  channelId: string;
  messageId: string;
  callerId: string;
  callerName: string;
  video: boolean;
  /** Unix seconds after which the ring is over even if no stop arrives. */
  ringUntil: number;
};

export type RingEvent =
  | { type: "ring"; ring: IncomingRing }
  | { type: "stop"; channelId: string }
  | { type: "tick"; now: number };

/**
 * The rings still waiting after `event`. One ring per chat (a repeat replaces it), a stop
 * ends that chat's ring, and a tick drops rings whose time is up. Returns the same array
 * when nothing changes.
 */
export function nextRings(rings: readonly IncomingRing[], event: RingEvent): IncomingRing[] {
  switch (event.type) {
    case "ring": {
      const others = rings.filter((r) => r.channelId !== event.ring.channelId);
      return [...others, event.ring];
    }
    case "stop": {
      if (!rings.some((r) => r.channelId === event.channelId)) return rings as IncomingRing[];
      return rings.filter((r) => r.channelId !== event.channelId);
    }
    case "tick": {
      if (!rings.some((r) => r.ringUntil < event.now)) return rings as IncomingRing[];
      return rings.filter((r) => r.ringUntil >= event.now);
    }
  }
}

/** "45s", "12m 03s", "1h 02m": like Discord's call log. */
export function formatCallDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}h ${two(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${two(seconds)}s`;
  return `${seconds}s`;
}

export type CallLogContext = {
  viewerId: string;
  callerId: string;
  callerName: string;
  /** The name of whoever declined, for a declined call. */
  declinerName?: string;
};

/** What a call log says to the person reading it. */
export function callLogText(call: CallLog, ctx: CallLogContext): string {
  const youCalled = ctx.viewerId === ctx.callerId;
  switch (call.state) {
    case "ringing":
      return youCalled ? "Calling…" : `${ctx.callerName} is calling…`;
    case "ongoing":
      return youCalled ? "You started a call" : `${ctx.callerName} started a call`;
    case "ended":
      return `Call ended · ${formatCallDuration(call.duration_secs ?? 0)}`;
    case "missed":
      return youCalled ? "No answer" : `Missed call from ${ctx.callerName}`;
    case "declined":
      if (call.declined_by && call.declined_by === ctx.viewerId) return "You declined";
      return `${ctx.declinerName ?? "They"} declined`;
  }
}

/** True for a call message that should count as unread: only a call you missed. */
export function callCountsAsUnread(call: CallLog, viewerId: string, callerId: string): boolean {
  return call.state === "missed" && viewerId !== callerId;
}
