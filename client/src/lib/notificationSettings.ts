// Notification settings (stub: the rules land in the next commit).

export type NotificationLevel = "all" | "mentions" | "nothing";
export type NotificationTarget = "server" | "channel";
export type NotificationSetting = {
  target_type: NotificationTarget;
  target_id: string;
  level: NotificationLevel | null;
  muted: boolean;
  muted_until: number | null;
};
export type NotificationSettings = Readonly<Record<string, NotificationSetting>>;
export type ChatContext = { channelId: string; serverId: string | null };
export type MessageAlert = { notify: boolean; count: boolean; show: boolean };

export const MUTE_CHOICES: readonly { label: string; seconds: number | null }[] = [];

export function settingKey(type: NotificationTarget, id: string): string {
  return `${type}:${id}`;
}

export function settingsFromList(_list: readonly NotificationSetting[]): NotificationSettings {
  return {};
}

export function withSetting(settings: NotificationSettings, _setting: NotificationSetting): NotificationSettings {
  return settings;
}

export function isMuted(_setting: NotificationSetting | undefined, _nowSec: number): boolean {
  return false;
}

export function messageAlert(
  _settings: NotificationSettings,
  _chat: ChatContext,
  _mentioned: boolean,
  _nowSec: number,
): MessageAlert {
  return { notify: true, count: true, show: true };
}

export function unreadFor(
  unread: Readonly<Record<string, number>>,
  _mentions: ReadonlySet<string>,
  _settings: NotificationSettings,
  _serverOf: (channelId: string) => string | null | undefined,
  _nowSec: number,
): { shown: Record<string, number>; counted: Record<string, number> } {
  return { shown: { ...unread }, counted: { ...unread } };
}

export function describeMute(_setting: NotificationSetting | undefined, _nowSec: number): string | null {
  return null;
}

export function nextMuteExpiry(_settings: NotificationSettings, _nowSec: number): number | null {
  return null;
}
