// The words and numbers behind the moderation tools: how long a time out or a channel's
// slowmode can be, the invite options, how long until someone may post again, what a
// timed-out member is told, and how the moderation log names each action. The lengths
// match the server's (server/src/api/moderation.rs), which refuses anything else.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const TIMEOUT_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: "60 seconds" },
  { seconds: 5 * MINUTE, label: "5 minutes" },
  { seconds: 10 * MINUTE, label: "10 minutes" },
  { seconds: HOUR, label: "1 hour" },
  { seconds: DAY, label: "1 day" },
  { seconds: WEEK, label: "1 week" },
];

const SLOWMODE_SECONDS = [0, 5, 10, 30, MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR];

export const SLOWMODE_CHOICES: readonly { seconds: number; label: string }[] = SLOWMODE_SECONDS.map((seconds) => ({
  seconds,
  label: slowmodeLabel(seconds),
}));

export const INVITE_EXPIRY_CHOICES: readonly { seconds: number | null; label: string }[] = [
  { seconds: 30 * MINUTE, label: "30 minutes" },
  { seconds: HOUR, label: "1 hour" },
  { seconds: 6 * HOUR, label: "6 hours" },
  { seconds: 12 * HOUR, label: "12 hours" },
  { seconds: DAY, label: "1 day" },
  { seconds: WEEK, label: "7 days" },
  { seconds: null, label: "Never" },
];

export const INVITE_MAX_USES_CHOICES: readonly { uses: number | null; label: string }[] = [
  { uses: null, label: "No limit" },
  { uses: 1, label: "1 use" },
  { uses: 5, label: "5 uses" },
  { uses: 10, label: "10 uses" },
  { uses: 25, label: "25 uses" },
  { uses: 50, label: "50 uses" },
  { uses: 100, label: "100 uses" },
];

/** How far back a ban can take the person's messages with it (the server allows these). */
export const BAN_DELETE_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 0, label: "Don't delete any" },
  { seconds: HOUR, label: "From the last hour" },
  { seconds: DAY, label: "From the last 24 hours" },
  { seconds: WEEK, label: "From the last 7 days" },
];

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A length of time in the largest whole unit that fits: "10 seconds", "1 minute", "6 hours". */
export function durationLabel(seconds: number): string {
  if (seconds >= WEEK && seconds % WEEK === 0) return plural(seconds / WEEK, "week");
  if (seconds >= DAY && seconds % DAY === 0) return plural(seconds / DAY, "day");
  if (seconds >= HOUR && seconds % HOUR === 0) return plural(seconds / HOUR, "hour");
  if (seconds >= MINUTE && seconds % MINUTE === 0) return plural(seconds / MINUTE, "minute");
  return plural(seconds, "second");
}

/** What a slowmode setting is called: "Off", "10 seconds", "15 minutes"… */
export function slowmodeLabel(seconds: number): string {
  return seconds <= 0 ? "Off" : durationLabel(seconds);
}

/** Whole seconds until someone may post again in slowmode, rounded up so it never says 0
 *  while the server would still refuse. 0 when they may post now. */
export function slowmodeWait(lastSentAt: number | null, slowmodeSeconds: number, now: number): number {
  if (lastSentAt == null || slowmodeSeconds <= 0) return 0;
  const left = lastSentAt + slowmodeSeconds * 1000 - now;
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** When a time out ends, as a timed-out member reads it: the time today, or the day and
 *  time when it ends on another day. */
export function timeoutEnds(until: number, now: number, locale?: string): string {
  const end = new Date(until * 1000);
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return sameDay(end, new Date(now))
    ? end.toLocaleTimeString(locale, time)
    : end.toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", ...time });
}

/** What a timed-out member is told, or null once the time out has run out. */
export function timeoutNotice(until: number, now: number, locale?: string): string | null {
  if (until * 1000 <= now) return null;
  return `You're timed out until ${timeoutEnds(until, now, locale)}. You can read, but you can't post, react or join voice.`;
}

/** Roughly how long is left, in the largest unit that reads naturally. */
function timeLeft(seconds: number): string {
  if (seconds >= DAY) return plural(Math.round(seconds / DAY), "day");
  if (seconds >= HOUR) return plural(Math.round(seconds / HOUR), "hour");
  return plural(Math.max(1, Math.ceil(seconds / MINUTE)), "minute");
}

/** How long an invite link lasts and how many uses it has left: "Expires in 7 days · no
 *  limit", "Never expires · 1 use left", "Expired", "Used up". */
export function inviteSummary(
  invite: { expires_at: number | null; max_uses: number | null; uses: number },
  now: number,
): string {
  const nowSec = now / 1000;
  if (invite.expires_at != null && invite.expires_at <= nowSec) return "Expired";
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return "Used up";
  const lasts = invite.expires_at == null ? "Never expires" : `Expires in ${timeLeft(invite.expires_at - nowSec)}`;
  const left = invite.max_uses == null ? "no limit" : `${plural(invite.max_uses - invite.uses, "use")} left`;
  return `${lasts} · ${left}`;
}

function metadataSeconds(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { seconds?: unknown };
    return typeof parsed.seconds === "number" ? parsed.seconds : null;
  } catch {
    return null;
  }
}

const ACTION_WORDS: Record<string, string> = {
  ban_member: "Banned",
  unban_member: "Lifted a ban",
  kick_member: "Kicked",
  remove_timeout: "Lifted a time out",
  delete_message: "Deleted a message",
  pause_invites: "Paused invites",
  resume_invites: "Resumed invites",
  members_invite_on: "Let members create invites",
  members_invite_off: "Stopped members creating invites",
  create_report: "Reported",
  block_user: "Blocked",
  unblock_user: "Unblocked",
  reorder_roles: "Reordered roles",
  set_channel_permissions: "Changed a channel's permissions",
  sync_channel_permissions: "Synced a channel with its category",
};

function metadataName(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}

/** The actions the moderation log can be filtered by, in plain words. */
export const MOD_ACTION_FILTERS: readonly { action: string; label: string }[] = [
  { action: "ban_member", label: "Bans" },
  { action: "unban_member", label: "Lifted bans" },
  { action: "kick_member", label: "Kicks" },
  { action: "timeout_member", label: "Time outs" },
  { action: "remove_timeout", label: "Lifted time outs" },
  { action: "delete_message", label: "Deleted messages" },
  { action: "set_slowmode", label: "Slowmode" },
  { action: "pause_invites", label: "Paused invites" },
  { action: "resume_invites", label: "Resumed invites" },
  { action: "update_role", label: "Role edits" },
  { action: "set_channel_permissions", label: "Channel permissions" },
];

/** One moderation log action in plain words: "Banned", "Timed out for 10 minutes"… */
export function describeModAction(entry: { action: string; metadata: string | null }): string {
  if (entry.action === "timeout_member") {
    const seconds = metadataSeconds(entry.metadata);
    const choice = TIMEOUT_CHOICES.find((c) => c.seconds === seconds);
    return seconds == null ? "Timed out" : `Timed out for ${choice?.label ?? durationLabel(seconds)}`;
  }
  if (entry.action === "set_slowmode") {
    const seconds = metadataSeconds(entry.metadata) ?? 0;
    return seconds > 0 ? `Set slowmode to ${slowmodeLabel(seconds)}` : "Turned slowmode off";
  }
  if (entry.action === "update_role") {
    const name = metadataName(entry.metadata);
    return name ? `Edited the ${name} role` : "Edited a role";
  }
  if (entry.action === "rename_space") {
    const name = metadataName(entry.metadata);
    return name ? `Renamed the space to ${name}` : "Renamed the space";
  }
  if (entry.action === "update_channel") {
    const name = metadataName(entry.metadata);
    return name ? `Edited #${name}` : "Edited a channel";
  }
  const words = ACTION_WORDS[entry.action];
  if (words) return words;
  const spaced = entry.action.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Whether to offer an action like Time out on `memberId`: you have the permission, they're
 * not the owner or you, and they're among the members the server says you outrank
 * (`moderatable`, from GET /servers/{id}/moderatable; until it answers, only the owner and
 * you are left out). The server refuses the rest anyway.
 */
export function canActOn(
  memberId: string,
  ctx: { ownerId: string; currentUserId: string; allowed: boolean; moderatable?: ReadonlySet<string> },
): boolean {
  if (!ctx.allowed || memberId === ctx.ownerId || memberId === ctx.currentUserId) return false;
  return ctx.moderatable ? ctx.moderatable.has(memberId) : true;
}
