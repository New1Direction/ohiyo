// Stub: the dialog lands in the next commit.
import type { NotificationLevel, NotificationSetting } from "../lib/notificationSettings";

export type NotificationSettingsTarget = {
  type: "server" | "channel";
  id: string;
  name: string;
  kind: "space" | "channel" | "dm";
};

export type NotificationSettingsSave = { level?: NotificationLevel | null; muted: boolean; mute_seconds?: number | null };

type Props = {
  target: NotificationSettingsTarget;
  setting: NotificationSetting | undefined;
  now: number;
  onSave: (body: NotificationSettingsSave) => Promise<void>;
  onClose: () => void;
};

export function NotificationSettingsDialog(_props: Props) {
  return null;
}
