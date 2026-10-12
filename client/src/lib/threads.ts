import type { Channel } from "../api.ts";

/** A thread as the server lists it: its channel plus how busy it is. */
export type ThreadSummary = Channel & {
  parent_id: string | null;
  thread_message_id: string | null;
  message_count: number;
  last_message_at: number | null;
  starter_deleted: boolean;
};

export function defaultThreadName(_content: string): string {
  return "";
}

export function threadChipLabel(_count: number, _lastMessageAt: number | null, _now: number): string {
  return "";
}

export function upsertThread(list: readonly ThreadSummary[], _thread: ThreadSummary): ThreadSummary[] {
  return [...list];
}

export function threadsByMessage(_threads: readonly ThreadSummary[]): Map<string, ThreadSummary> {
  return new Map();
}

export function canStartThread(_channel: Pick<Channel, "server_id" | "channel_type"> & { parent_id?: string | null }): boolean {
  return false;
}
