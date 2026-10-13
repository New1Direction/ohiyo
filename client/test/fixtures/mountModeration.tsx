import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { TimeoutDialog } from "../../src/components/moderation/TimeoutDialog";
import { BanDialog } from "../../src/components/moderation/BanDialog";
import { BansDialog, type BanEntry } from "../../src/components/moderation/BansDialog";
import { InvitesDialog, type InviteRow, type InviteSettings } from "../../src/components/moderation/InvitesDialog";
import { ModerationLog, type LogEntry } from "../../src/components/moderation/ModerationLog";
import { ComposerModerationNotice } from "../../src/components/moderation/ComposerModerationNotice";
import { SlowmodeDialog } from "../../src/components/moderation/SlowmodeDialog";
export { act };

function mount(element: HTMLElement, node: React.ReactNode) {
  const root = createRoot(element);
  act(() => root.render(node));
  return () => act(() => root.unmount());
}

/** The time out dialog for one member, recording what it confirms. */
export function mountTimeoutDialog(element: HTMLElement) {
  const confirmed: string[] = [];
  let closed = 0;
  const unmount = mount(
    element,
    <TimeoutDialog
      name="Spammer"
      onConfirm={(seconds, reason) => {
        confirmed.push(`${seconds} ${reason}`);
      }}
      onClose={() => {
        closed += 1;
      }}
    />,
  );
  return { confirmed, closed: () => closed, unmount };
}

/** The ban dialog for one member, recording what it confirms. */
export function mountBanDialog(element: HTMLElement) {
  const confirmed: string[] = [];
  const unmount = mount(
    element,
    <BanDialog
      name="Spammer"
      onConfirm={({ reason, deleteMessageSeconds }) => {
        confirmed.push(`${deleteMessageSeconds} ${reason}`);
      }}
      onClose={() => {}}
    />,
  );
  return { confirmed, unmount };
}

/** The ban list, backed by an in-memory list. */
export function mountBansDialog(element: HTMLElement, initial: BanEntry[]) {
  const calls: string[] = [];
  let bans = [...initial];
  const unmount = mount(
    element,
    <BansDialog
      api={{
        list: async () => {
          calls.push("list");
          return bans;
        },
        unban: async (userId) => {
          calls.push(`unban ${userId}`);
          bans = bans.filter((b) => b.user.id !== userId);
        },
      }}
      onClose={() => {}}
    />,
  );
  return { calls, unmount };
}

/** The invites dialog, backed by an in-memory list and settings. */
export function mountInvitesDialog(element: HTMLElement, initial: InviteRow[], canManageServer: boolean, now: number) {
  const calls: string[] = [];
  let invites = [...initial];
  let settings: InviteSettings = { paused: false, members_can_invite: true };
  const unmount = mount(
    element,
    <InvitesDialog
      canManageServer={canManageServer}
      now={now}
      api={{
        list: async () => {
          calls.push("list");
          return invites;
        },
        revoke: async (code) => {
          calls.push(`revoke ${code}`);
          invites = invites.filter((i) => i.code !== code);
        },
        getSettings: async () => {
          calls.push("settings");
          return canManageServer ? settings : null;
        },
        updateSettings: async (patch) => {
          calls.push(`update ${JSON.stringify(patch)}`);
          settings = { ...settings, ...patch };
          return settings;
        },
      }}
      onClose={() => {}}
    />,
  );
  return { calls, unmount };
}

/** The moderation log, backed by pages of entries. */
export function mountModerationLog(element: HTMLElement, pages: LogEntry[][]) {
  const calls: string[] = [];
  const unmount = mount(
    element,
    <ModerationLog
      pageSize={2}
      api={{
        list: async ({ action, before }) => {
          calls.push(`list ${action ?? "all"} ${before ?? "-"}`);
          const page = before === undefined ? 0 : 1;
          const rows = pages[page] ?? [];
          return action ? rows.filter((r) => r.action === action) : rows;
        },
      }}
    />,
  );
  return { calls, unmount };
}

/** What the composer area says while timed out or in slowmode. */
export function mountComposerNotice(
  element: HTMLElement,
  props: { timedOutUntil: number | null; slowmodeSeconds: number; lastSentAt: number | null; now: number },
) {
  return { unmount: mount(element, <ComposerModerationNotice {...props} locale="en-US" />) };
}

/** The slowmode picker for one channel. */
export function mountSlowmodeDialog(element: HTMLElement, seconds: number) {
  const saved: number[] = [];
  const unmount = mount(
    element,
    <SlowmodeDialog
      channelName="general"
      seconds={seconds}
      onSave={(s) => {
        saved.push(s);
      }}
      onClose={() => {}}
    />,
  );
  return { saved, unmount };
}
