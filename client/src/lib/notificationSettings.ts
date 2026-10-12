// Notification settings, like Discord's. A space notifies for every message, only for
// @mentions, or not at all; a space, a channel, a DM or a group chat can be muted for a
// while or until it's turned back on. The server keeps them per account and its push relay
// follows the same rules (server/src/api/notifications.rs: should_push).

export type NotificationLevel = "all" | "mentions" | "nothing";
export type NotificationTarget = "server" | "channel";
export type NotificationSetting = {
  target_type: NotificationTarget;
  target_id: string;
  /** A space's level; null is the default (all messages). */
  level: NotificationLevel | null;
  muted: boolean;
  /** When a mute ends, in unix seconds; null while muted: until it's turned back on. */
  muted_until: number | null;
};
/** Settings by `settingKey(type, id)`; only what differs from the defaults is kept. */
export type NotificationSettings = Readonly<Record<string, NotificationSetting>>;
export type ChatContext = { channelId: string; serverId: string | null };
/** What a message does: pop a notification (and a push), add to the Dock and tab-title
 *  number, and show as unread in the sidebar. */
export type MessageAlert = { notify: boolean; count: boolean; show: boolean };

export const MUTE_CHOICES: readonly { label: string; seconds: number | null }[] = [
  { label: "For 15 minutes", seconds: 15 * 60 },
  { label: "For 1 hour", seconds: 60 * 60 },
  { label: "For 8 hours", seconds: 8 * 60 * 60 },
  { label: "For 24 hours", seconds: 24 * 60 * 60 },
  { label: "Until I turn it back on", seconds: null },
];

export function settingKey(type: NotificationTarget, id: string): string {
  return `${type}:${id}`;
}

function isDefault(setting: NotificationSetting): boolean {
  return !setting.muted && (setting.level === null || setting.level === "all");
}

export function settingsFromList(list: readonly NotificationSetting[]): NotificationSettings {
  let settings: NotificationSettings = {};
  for (const setting of list) settings = withSetting(settings, setting);
  return settings;
}

/** A new map with `setting` in place of the old one; back to the defaults removes it. */
export function withSetting(settings: NotificationSettings, setting: NotificationSetting): NotificationSettings {
  const key = settingKey(setting.target_type, setting.target_id);
  const next: Record<string, NotificationSetting> = { ...settings };
  delete next[key];
  if (!isDefault(setting)) next[key] = setting;
  return next;
}

export function isMuted(setting: NotificationSetting | undefined, nowSec: number): boolean {
  if (!setting?.muted) return false;
  return setting.muted_until === null || setting.muted_until > nowSec;
}

export function messageAlert(
  settings: NotificationSettings,
  chat: ChatContext,
  mentioned: boolean,
  nowSec: number,
): MessageAlert {
  const channelMuted = isMuted(settings[settingKey("channel", chat.channelId)], nowSec);
  // A DM or group chat: muted means silent, mention or not.
  if (chat.serverId === null) {
    const on = !channelMuted;
    return { notify: on, count: on, show: on };
  }
  const space = settings[settingKey("server", chat.serverId)];
  const muted = channelMuted || isMuted(space, nowSec);
  const level = space?.level ?? "all";
  if (level === "nothing") return { notify: false, count: false, show: !muted };
  // An @mention gets through a mute, as in Discord.
  if (mentioned) return { notify: true, count: true, show: true };
  if (muted) return { notify: false, count: false, show: false };
  if (level === "mentions") return { notify: false, count: false, show: true };
  return { notify: true, count: true, show: true };
}

/** Unread counts split into what the sidebar shows and what the Dock and tab title count. */
export function unreadFor(
  unread: Readonly<Record<string, number>>,
  mentions: ReadonlySet<string>,
  settings: NotificationSettings,
  serverOf: (channelId: string) => string | null | undefined,
  nowSec: number,
): { shown: Record<string, number>; counted: Record<string, number> } {
  const shown: Record<string, number> = {};
  const counted: Record<string, number> = {};
  for (const [channelId, count] of Object.entries(unread)) {
    if (!count) continue;
    const alert = messageAlert(settings, { channelId, serverId: serverOf(channelId) ?? null }, mentions.has(channelId), nowSec);
    if (alert.show) shown[channelId] = count;
    if (alert.count) counted[channelId] = count;
  }
  return { shown, counted };
}

/** "Muted until 3:45 PM" (with the date when it isn't today), or null when not muted. */
export function describeMute(setting: NotificationSetting | undefined, nowSec: number): string | null {
  if (!setting || !isMuted(setting, nowSec)) return null;
  if (setting.muted_until === null) return "Muted until you turn it back on";
  const end = new Date(setting.muted_until * 1000);
  const sameDay = end.toDateString() === new Date(nowSec * 1000).toDateString();
  const time = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `Muted until ${time}`
    : `Muted until ${end.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

/** The soonest moment a mute ends, so the app can refresh then; null when none will. */
export function nextMuteExpiry(settings: NotificationSettings, nowSec: number): number | null {
  let next: number | null = null;
  for (const setting of Object.values(settings)) {
    const until = setting.muted ? setting.muted_until : null;
    if (until !== null && until > nowSec && (next === null || until < next)) next = until;
  }
  return next;
}
