import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChannelSidebar } from "../../src/components/ChannelSidebar";
// The same drafts module the sidebar reads, so a test can write a draft it will see.
export { persistDraft, forgetAllDrafts } from "../../src/lib/drafts";
export { act };

type Options = {
  /** The signed-in person owns the space (they delete it rather than leave). */
  owner: boolean;
  /** They may manage the space and its channels (logo, channels, moderation queue). */
  manage: boolean;
  /** Offer "Notification settings" in the space menu. */
  notificationSettings?: boolean;
  /** Offer "Webhooks" in the space menu (only shown to people who manage channels). */
  webhooks?: boolean;
  /** Channels the person has muted. */
  mutedChannelIds?: string[];
  /** Unread counts by channel. */
  unread?: Record<string, number>;
  /** Offer "Invites" (the space's links) and "Bans" (people who can ban) in the space menu. */
  invites?: boolean;
  bans?: boolean;
  /** Offer Mark as read (a channel's menu) and Mark space as read (the space menu). */
  markRead?: boolean;
};

/** The channel sidebar for one space, with every header action recorded by name. */
export function mountChannelSidebar(
  element: HTMLElement,
  { owner, manage, notificationSettings, webhooks, mutedChannelIds, unread, invites, bans, markRead }: Options,
) {
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
        onOpenWebhooks={webhooks ? record("webhooks") : undefined}
        onMarkRead={markRead ? (ids: string[]) => void calls.push(`mark read ${ids.join(",")}`) : undefined}
        onMarkSpaceRead={markRead ? record("mark space read") : undefined}
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
        onOpenInvites={invites ? record("invites") : undefined}
        onOpenBans={bans ? record("bans") : undefined}
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
