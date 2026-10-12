import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { NotificationSettingsDialog, type NotificationSettingsTarget } from "../../src/components/NotificationSettingsDialog";
import type { NotificationSetting } from "../../src/lib/notificationSettings";
export { act };

export type SaveCall = { level?: string | null; muted: boolean; mute_seconds?: number | null };

/** The notification settings dialog for one space, channel or DM, with saves recorded. */
export function mountNotificationSettings(
  element: HTMLElement,
  target: NotificationSettingsTarget,
  setting: NotificationSetting | undefined,
  now: number,
) {
  const saves: SaveCall[] = [];
  let closed = 0;
  const root = createRoot(element);
  act(() =>
    root.render(
      <NotificationSettingsDialog
        target={target}
        setting={setting}
        now={now}
        onSave={async (body) => {
          saves.push(body);
        }}
        onClose={() => {
          closed += 1;
        }}
      />,
    ),
  );
  return { saves, closed: () => closed, unmount: () => act(() => root.unmount()) };
}
