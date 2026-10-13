// Calls in DMs and group chats: the rings waiting for an answer, and what a call log in the
// chat says. (Stub: the real rules come with the feature.)

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

export function nextRings(rings: readonly IncomingRing[], _event: RingEvent): IncomingRing[] {
  return [...rings];
}

export function formatCallDuration(_secs: number): string {
  return "";
}

export type CallLogContext = {
  viewerId: string;
  callerId: string;
  callerName: string;
  declinerName?: string;
};

export function callLogText(_call: CallLog, _ctx: CallLogContext): string {
  return "";
}

/** True for a call message that should count as unread (only a call you missed). */
export function callCountsAsUnread(_call: CallLog, _viewerId: string, _callerId: string): boolean {
  return true;
}
