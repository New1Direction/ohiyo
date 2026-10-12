import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChannelSidebar } from "../../src/components/ChannelSidebar";
export { act };

type Options = {
  /** The signed-in person owns the space (they delete it rather than leave). */
  owner: boolean;
  /** They may manage the space and its channels (logo, channels, moderation queue). */
  manage: boolean;
  /** Offer "Notification settings" in the space menu. */
  notificationSettings?: boolean;
  /** Channels the person has muted. */
  mutedChannelIds?: string[];
  /** Unread counts by channel. */
  unread?: Record<string, number>;
};

/** The channel sidebar for one space, with every header action recorded by name. */
export function mountChannelSidebar(element: HTMLElement, { owner, manage, notificationSettings, mutedChannelIds, unread }: Options) {
  const calls: string[] = [];
  const me = { id: "me", username: "me", display_name: "Me", avatar_url: null };
  const server = {
    id: "s1",
    name: "Gate HQ",
    owner_id: owner ? "me" : "someone-else",
    icon_url: null,
    channels: [
      { id: "c1", server_id: "s1", name: "general", channel_type: "text", position: 0, created_at: 0 },
      { id: "c2", server_id: "s1", name: "General", channel_type: "voice", position: 1, created_at: 0 },
      { id: "c3", server_id: "s1", name: "random", channel_type: "text", position: 2, created_at: 0 },
    ],
    members: [me],
    categories: [],
  };
  const record = (name: string) => () => {
    calls.push(name);
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <ChannelSidebar
        server={server as never}
        dms={[]}
        dmUsers={{}}
        selectedChannelId="c1"
        unread={unread}
        mutedChannelIds={mutedChannelIds ? new Set(mutedChannelIds) : undefined}
        onOpenNotificationSettings={notificationSettings ? record("notification settings") : undefined}
        currentUser={me as never}
        connStatus="connected"
        onlineUsers={new Set()}
        activeVoiceChannelId={null}
        voiceParticipantCount={0}
        canManageChannels={manage}
        canManageServer={manage}
        onSelectChannel={record("select channel")}
        onJoinVoice={record("join voice")}
        onCreateChannel={record("create channel")}
        onSetServerIcon={manage ? record("set logo") : undefined}
        onInvite={record("invite")}
        onOpenEvents={record("events")}
        onReportServer={record("report")}
        onOpenModQueue={manage ? record("moderation queue") : undefined}
        onLeaveServer={async () => {
          calls.push("leave");
        }}
        onDeleteServer={async () => {
          calls.push("delete");
        }}
        onLogout={record("log out")}
        onOpenSettings={record("settings")}
      />,
    ),
  );
  return { calls, unmount: () => act(() => root.unmount()) };
}
