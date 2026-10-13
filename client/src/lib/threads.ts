// Threads: a reply chain started from one message in a space's text channel. A thread is a
// channel of its own that hangs off its parent channel; the server lists a channel's threads
// and sends a ThreadUpdate when one starts or its message count changes. You follow a thread
// when you start it or reply in it: a followed thread counts as unread and notifies like its
// channel; the rest only on an @mention. A thread nobody wrote in for a week is archived.
import type { Channel } from "../api";
import { messageAlert, type MessageAlert, type NotificationSettings } from "./notificationSettings.ts";
import { PERM, can } from "../permissions.ts";

/** A thread as the server lists it: its channel plus how busy it is. */
export type ThreadSummary = Channel & {
  parent_id: string | null;
  thread_message_id: string | null;
  message_count: number;
  last_message_at: number | null;
  starter_deleted: boolean;
  /** Who started it; null once they've deleted their account. Absent from older servers. */
  owner_id?: string | null;
  /** No messages for a week (the server's view when it was listed). */
  archived?: boolean;
  /** Whether you follow it; only in your own list, not in what everyone hears. */
  following?: boolean;
};

/** Longest suggested name; the person can type up to 100 characters. */
const SUGGESTED_NAME_CHARS = 40;

/** The name a new thread starts with: the first line of its message, cut at a word. */
export function defaultThreadName(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.trim().split(/\s+/).filter(Boolean).join(" "))
      .find((l) => l.length > 0) ?? "";
  if (!line) return "Thread";
  if (line.length <= SUGGESTED_NAME_CHARS) return line;
  const cut = line.slice(0, SUGGESTED_NAME_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const words = lastSpace > SUGGESTED_NAME_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${words.trimEnd()}…`;
}

function ago(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The line under a message that started a thread. */
export function threadChipLabel(count: number, lastMessageAt: number | null, now: number): string {
  if (count <= 0 || lastMessageAt === null) return "No replies yet";
  const replies = `${count} ${count === 1 ? "reply" : "replies"}`;
  const when = ago(Math.max(0, now - lastMessageAt));
  return when === "just now" ? `${replies} · just now` : `${replies} · last reply ${when}`;
}

const activity = (t: ThreadSummary) => t.last_message_at ?? t.created_at;

/** Add or replace a thread in a channel's list, keeping the busiest first. */
export function upsertThread(list: readonly ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  return [...list.filter((t) => t.id !== thread.id), thread].sort(
    (a, b) => activity(b) - activity(a) || b.created_at - a.created_at || a.id.localeCompare(b.id)
  );
}

/** A channel's threads by the message each started from (those whose message still exists). */
export function threadsByMessage(threads: readonly ThreadSummary[]): Map<string, ThreadSummary> {
  const map = new Map<string, ThreadSummary>();
  for (const t of threads) {
    if (t.thread_message_id && !t.starter_deleted) map.set(t.thread_message_id, t);
  }
  return map;
}

/** Only a space's text channels have threads, and a thread has none of its own. */
export function canStartThread(
  channel: Pick<Channel, "server_id" | "channel_type"> & { parent_id?: string | null }
): boolean {
  return Boolean(channel.server_id) && channel.channel_type === "text" && !channel.parent_id;
}

/** A thread nobody has written in for this long reads as archived (the server agrees). */
export const ARCHIVE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/** No message for a week (or, with no replies, started more than a week ago). */
export function isArchived(thread: ThreadSummary, now: number): boolean {
  return activity(thread) <= now - ARCHIVE_AFTER_SECONDS;
}

/** A channel's threads, active ones first and archived ones under "Older", each in order. */
export function splitThreads(list: readonly ThreadSummary[], now: number): { active: ThreadSummary[]; older: ThreadSummary[] } {
  return {
    active: list.filter((t) => !isArchived(t, now)),
    older: list.filter((t) => isArchived(t, now)),
  };
}

/** A channel's list without a deleted thread (the same list when it wasn't there). */
export function removeThread(list: readonly ThreadSummary[], id: string): ThreadSummary[] {
  return list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : (list as ThreadSummary[]);
}

/** The set of threads you follow, with one followed or unfollowed. */
export function withFollow(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Whoever started a thread, or someone who manages messages or channels, may rename or
 *  delete it (the server checks the same against the channel's own permissions). */
export function canManageThread(thread: ThreadSummary, me: string, perms: number): boolean {
  if (thread.owner_id && thread.owner_id === me) return true;
  return can(perms, PERM.MANAGE_MESSAGES) || can(perms, PERM.MANAGE_CHANNELS) || can(perms, PERM.ADMINISTRATOR);
}

const NO_ALERT: MessageAlert = { notify: false, count: false, show: false };

/** What a reply in a thread does: a followed thread acts like its channel (under the
 *  channel's and the space's notification settings); an unfollowed one only for an @mention. */
export function threadAlert(
  settings: NotificationSettings,
  ctx: { parentId: string; serverId: string | null },
  following: boolean,
  mentioned: boolean,
  now: number,
): MessageAlert {
  if (!following && !mentioned) return NO_ALERT;
  return messageAlert(settings, { channelId: ctx.parentId, serverId: ctx.serverId }, mentioned, now);
}
