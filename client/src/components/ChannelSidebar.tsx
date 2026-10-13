import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { ActivationChecklist } from "./ActivationChecklist";
import { SpaceOptions } from "./SpaceOptions";
import { SpaceMenu, type SpaceMenuItem } from "./SpaceMenu";
import type { Channel, ServerWithChannels, PublicUser } from "../api";
import type { ActivationState } from "../lib/activation";
import type { ConnectionStatus, Activity } from "../gateway";
import { AvatarMark } from "./BirdMark";
import { OnlineDot, STATUS_META } from "./presence";
import { UserPanel } from "./UserPanel";

// Set through backgroundImage (not the `background` shorthand): React clears backgroundImage
// to "" when there is no picture, which would wipe a gradient set by the shorthand.
const AVATAR_FALLBACK_BG = "linear-gradient(135deg, var(--text-primary), var(--text-muted))";

type VoiceSidebarParticipant = {
  user_id: string;
  user: PublicUser;
  muted: boolean;
  video: boolean;
  screen: boolean;
  listenOnly: boolean;
  isSelf?: boolean;
};

type Props = {
  server: ServerWithChannels | null;
  dms: Channel[];
  dmUsers: Record<string, PublicUser>;
  selectedChannelId: string | null;
  currentUser: PublicUser | null;
  connStatus: ConnectionStatus;
  onlineUsers: Set<string>;
  idleUsers?: Set<string>;
  activeVoiceChannelId: string | null;
  voiceParticipantCount: number;
  voiceParticipantsByChannel?: Map<string, VoiceSidebarParticipant[]>;
  unread?: Record<string, number>;
  mentionChannels?: Set<string>;
  /** Channels, DMs and group chats that are muted, or in a muted space. */
  mutedChannelIds?: ReadonlySet<string>;
  /** "Notification settings" in the space menu. */
  onOpenNotificationSettings?: () => void;
  /** Open the space's webhooks (offered to people who manage channels). */
  onOpenWebhooks?: () => void;
  myStatus?: string | null;
  onSetStatus?: (status: string) => void;
  myActivity?: Activity | null;
  onSetActivity?: (activity: Activity | null) => void;
  privacyMode?: boolean;
  canManageChannels?: boolean;
  canManageServer?: boolean;
  onOpenCategories?: () => void;
  onSelectChannel: (channel: Channel) => void;
  onJoinVoice: (channel: Channel, opts?: { muted?: boolean; video?: boolean }) => void;
  onCreateChannel: (name: string) => void;
  onSetServerIcon?: (serverId: string, file: File) => void | Promise<void>;
  onInvite?: () => void;
  onCreatePrivateDmLink?: () => void;
  onFindPeople?: () => void;
  onOpenEvents?: () => void;
  onReportServer?: () => void;
  onOpenModQueue?: () => void;
  /** Leave the space shown (a member). */
  onLeaveServer?: (serverId: string) => Promise<void>;
  /** Delete the space shown, with the password (its owner). */
  onDeleteServer?: (serverId: string, password: string) => Promise<void>;
  activationState?: ActivationState;
  showActivationChecklist?: boolean;
  onDismissActivationChecklist?: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;
};

function InvitePersonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </svg>
  );
}
function SpeakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

export function ChannelSidebar({
  server,
  dms,
  dmUsers,
  selectedChannelId,
  currentUser,
  connStatus,
  onlineUsers,
  idleUsers,
  activeVoiceChannelId,
  voiceParticipantCount,
  voiceParticipantsByChannel,
  unread,
  mentionChannels,
  mutedChannelIds,
  onOpenNotificationSettings,
  onOpenWebhooks,
  myStatus,
  onSetStatus,
  myActivity,
  onSetActivity,
  privacyMode,
  canManageChannels,
  canManageServer,
  onOpenCategories,
  onSelectChannel,
  onJoinVoice,
  onCreateChannel,
  onSetServerIcon,
  onInvite,
  onCreatePrivateDmLink,
  onFindPeople,
  onOpenEvents,
  onReportServer,
  onOpenModQueue,
  onLeaveServer,
  onDeleteServer,
  activationState,
  showActivationChecklist,
  onDismissActivationChecklist,
  onLogout,
  onOpenSettings,
}: Props) {
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const serverIconInputRef = useRef<HTMLInputElement>(null);
  // Space options is open for this space id; switching spaces closes it.
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const optionsOpen = server !== null && optionsFor === server.id;
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const isOwner = Boolean(server && currentUser && server.owner_id === currentUser.id);
  const closeOptions = () => {
    setOptionsFor(null);
    optionsButtonRef.current?.focus();
  };
  const canSetLogo = Boolean(server && canManageServer && onSetServerIcon);
  // The space menu, opened from the space's name: each action only for who may use it.
  const spaceMenuItems: SpaceMenuItem[] = [];
  if (server) {
    if (onInvite) spaceMenuItems.push({ label: "Invite people", icon: "userPlus", onSelect: onInvite });
    if (canSetLogo) {
      spaceMenuItems.push({ label: "Change space logo", icon: "edit", onSelect: () => serverIconInputRef.current?.click() });
    }
    if (canManageChannels) spaceMenuItems.push({ label: "Create channel", icon: "plus", onSelect: () => setShowNewChannel(true) });
    if (onOpenEvents) spaceMenuItems.push({ label: "Events", icon: "calendar", onSelect: onOpenEvents });
    if (onOpenModQueue) spaceMenuItems.push({ label: "Moderation queue", icon: "history", onSelect: onOpenModQueue });
    if (canManageChannels && onOpenWebhooks) spaceMenuItems.push({ label: "Webhooks", icon: "webhook", onSelect: onOpenWebhooks });
    if (onOpenNotificationSettings) {
      spaceMenuItems.push({ label: "Notification settings", icon: "bell", onSelect: onOpenNotificationSettings });
    }
    // Not for the people who run the space: reporting your own space to yourself helps nobody.
    if (onReportServer && !canManageServer) spaceMenuItems.push({ label: "Report space", icon: "flag", onSelect: onReportServer });
    if (isOwner ? onDeleteServer : onLeaveServer) {
      spaceMenuItems.push({
        label: isOwner ? "Delete space" : "Leave space",
        icon: isOwner ? "trash" : "leave",
        danger: true,
        onSelect: () => setOptionsFor(server.id),
      });
    }
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("kc:collapsed-cats") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [pinnedDmIds, setPinnedDmIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("kc:pinned-dms") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("kc:collapsed-cats", JSON.stringify([...next]));
      return next;
    });
  }
  function togglePinDm(id: string) {
    setPinnedDmIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("kc:pinned-dms", JSON.stringify([...next]));
      return next;
    });
  }

  function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (newChannelName.trim()) {
      onCreateChannel(newChannelName.trim());
      setNewChannelName("");
      setShowNewChannel(false);
    }
  }

  const textChannels = (server?.channels ?? []).filter((c) => c.channel_type === "text");
  const voiceChannels = (server?.channels ?? []).filter((c) => c.channel_type === "voice");
  const categories = [...(server?.categories ?? [])].sort((a, b) => a.position - b.position);
  const uncategorizedText = textChannels.filter((c) => !c.category_id);
  const firstVoiceChannel = voiceChannels[0] ?? null;

  const renderChannel = (ch: Channel) => (
    <ChannelRow
      key={ch.id}
      icon={<HashIcon />}
      name={ch.name}
      isSelected={selectedChannelId === ch.id}
      unreadCount={unread?.[ch.id] ?? 0}
      hasMention={mentionChannels?.has(ch.id) ?? false}
      muted={mutedChannelIds?.has(ch.id) ?? false}
      imported={Boolean(ch.imported)}
      onClick={() => onSelectChannel(ch)}
    />
  );

  const renderDmRow = (dm: Channel) => {
    const other = dmUsers[dm.id];
    const label = other?.display_name ?? other?.username ?? (dm.channel_type === "group_dm" ? dm.name || "Group DM" : "Direct Message");
    const online = other ? onlineUsers.has(other.id) : false;
    const isSel = selectedChannelId === dm.id;
    const muted = mutedChannelIds?.has(dm.id) ?? false;
    // A muted chat shows no unread number or mention badge: it's meant to stay quiet.
    const unreadCount = muted ? 0 : unread?.[dm.id] ?? 0;
    const hasUnread = unreadCount > 0 && !isSel;
    const showMention = !muted && (mentionChannels?.has(dm.id) ?? false) && !isSel;
    const pinned = pinnedDmIds.has(dm.id);
    return (
      <div
        key={dm.id}
        className="group mx-2 flex w-[calc(100%-1rem)] items-center gap-1 rounded-md"
        style={{
          background: isSel ? "color-mix(in oklch, var(--text-primary) 8%, transparent)" : "transparent",
          boxShadow: isSel ? "inset 3px 0 0 var(--accent)" : undefined,
        }}
      >
        <button
          type="button"
          onClick={() => onSelectChannel(dm)}
          className="kc-interactive flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
          style={{
            border: "none",
            borderRadius: "var(--radius-md)",
            background: "transparent",
            color: isSel || hasUnread || showMention ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: isSel || hasUnread || showMention ? 650 : 400,
          }}
        >
          <div className="relative flex-shrink-0">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold"
              style={{
                color: "var(--bg-base)",
                boxShadow: isSel ? "0 0 0 2px color-mix(in oklch, var(--accent) 22%, transparent)" : undefined,
                backgroundImage: other?.avatar_url ? `url(${other.avatar_url})` : AVATAR_FALLBACK_BG,
                backgroundSize: "cover", backgroundPosition: "center",
              }}
            >
              {!other?.avatar_url && (other ? <AvatarMark /> : label[0]?.toUpperCase())}
            </div>
            {online && (
              <OnlineDot
                color={other && idleUsers?.has(other.id) ? "var(--gold)" : "var(--green)"}
              />
            )}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm" style={muted ? { opacity: 0.6 } : undefined}>{label}</span>
          {muted && <MutedMark />}
          {showMention ? (
            <span
              className="flex-shrink-0 rounded-full px-1.5 text-xs font-bold"
              style={{ background: "var(--danger-fill)", color: "#fff", minWidth: 18, textAlign: "center" }}
              aria-label="You were mentioned"
            >
              @
            </span>
          ) : hasUnread ? (
            <span
              className="flex-shrink-0 rounded-full px-1.5 text-xs font-bold"
              style={{ background: "var(--accent)", color: "var(--bg-base)", minWidth: 18, textAlign: "center", boxShadow: "0 0 10px color-mix(in oklch, var(--accent) 42%, transparent)" }}
              aria-label={`${unreadCount} unread`}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => togglePinDm(dm.id)}
          className="kc-interactive mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-xs"
          style={{
            border: "none",
            cursor: "pointer",
            background: pinned ? "color-mix(in oklch, var(--text-primary) 10%, transparent)" : "transparent",
            color: pinned ? "var(--text-primary)" : "var(--text-muted)",
            boxShadow: pinned ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 22%, transparent)" : undefined,
            opacity: pinned ? 1 : 0.72,
          }}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          title={pinned ? "Unpin DM" : "Pin DM"}
        >
          {pinned ? "📌" : "☆"}
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-60 flex-shrink-0 flex-col" style={{ background: "var(--bg-sidebar)" }}>
      {/* Header */}
      <div
        className="kc-sidebar-header px-3 py-3 shadow-sm"
        style={{ borderBottom: "1px solid var(--bg-base)" }}
      >
        <div className="kc-space-title-row">
          {server?.icon_url && <img src={server.icon_url} alt="" className="h-8 w-8 flex-shrink-0 rounded-xl object-cover" />}
          <div className="min-w-0 flex-1">
            {server ? (
              <SpaceMenu name={server.name} items={spaceMenuItems} buttonRef={optionsButtonRef} />
            ) : (
              <div className="truncate" style={{ fontFamily: "var(--font-display)", fontWeight: 750, fontSize: "var(--text-lg)", color: "var(--text-primary)" }}>Direct Messages</div>
            )}
            <div className="truncate text-[11px] font-semibold" style={{ color: "var(--text-muted)", letterSpacing: "0.02em" }}>{server ? "Invite-only space" : "Your conversations"}</div>
          </div>
        </div>
        {server && canSetLogo && onSetServerIcon && (
          <input
            ref={serverIconInputRef}
            type="file"
            accept="image/*,.gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onSetServerIcon(server.id, file);
            }}
          />
        )}
        {server && onInvite && (
          <div className="mt-2 flex min-w-0 items-center">
            <button
              onClick={onInvite}
              title="Invite people"
              aria-label="Invite people"
              className="kc-sidebar-invite kc-interactive flex min-w-0 flex-1 items-center justify-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold"
              style={{ background: "color-mix(in oklch, var(--accent) 14%, transparent)", color: "var(--accent)" }}
            >
              <InvitePersonIcon />
              <span className="truncate">Invite</span>
            </button>
          </div>
        )}
        {server && optionsOpen && (
          <SpaceOptions
            name={server.name}
            isOwner={isOwner}
            onLeave={() => onLeaveServer?.(server.id) ?? Promise.resolve()}
            onDelete={(password) => onDeleteServer?.(server.id, password) ?? Promise.resolve()}
            onClose={closeOptions}
          />
        )}
      </div>

      {/* Connection banner — only visible when not healthy */}
      {connStatus !== "connected" && (
        <div
          className="flex items-center gap-2 px-4 py-1.5"
          style={{
            background: "color-mix(in oklch, var(--bg-base) 60%, transparent)",
            fontSize: "var(--text-xs)",
            color: STATUS_META[connStatus].color,
            fontWeight: 600,
          }}
        >
          <span className="kc-pulse" style={{ width: 7, height: 7, background: STATUS_META[connStatus].color }} />
          {STATUS_META[connStatus].label}
        </div>
      )}

      {/* Channel / DM list */}
      <div className="kc-touch-scroll flex-1 overflow-y-auto py-2">
        {server ? (
          <>
            {/* Text channels (uncategorized) */}
            <div className="mb-2">
              <div
                className="flex items-center justify-between px-4 py-1 text-xs font-bold uppercase"
                style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
              >
                <span>Text Channels</span>
                <div className="flex items-center gap-2">
                  {canManageChannels && onOpenCategories && (
                    <button
                      type="button"
                      onClick={onOpenCategories}
                      className="kc-interactive text-sm leading-none"
                      style={{ color: "var(--text-muted)" }}
                      title="Categories"
                      aria-label="Manage categories"
                    >
                      <Icon name="folder" size={16} />
                    </button>
                  )}
                  {canManageChannels && (
                    <button
                      type="button"
                      onClick={() => setShowNewChannel(true)}
                      className="kc-interactive text-lg leading-none"
                      style={{ color: "var(--text-muted)" }}
                      title="Create channel"
                      aria-label="Create channel"
                    >
                      +
                    </button>
                  )}
                </div>
              </div>

              {showNewChannel && (
                <form onSubmit={handleCreateChannel} className="mx-2 mb-1">
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- inline create-channel field opens on user action; focusing immediately is expected
                    autoFocus
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    maxLength={100}
                    onKeyDown={(e) => e.key === "Escape" && setShowNewChannel(false)}
                    placeholder="new-channel"
                    className="w-full px-2 py-1 text-sm outline-none"
                    style={{ background: "var(--bg-input)", color: "var(--text-primary)", borderRadius: "var(--radius-md)" }}
                  />
                </form>
              )}

              {uncategorizedText.map(renderChannel)}
            </div>

            {/* Categories (collapsible) */}
            {categories.map((cat) => {
              const chans = textChannels.filter((c) => c.category_id === cat.id);
              const isCollapsed = collapsed.has(cat.id);
              return (
                <div key={cat.id} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleCollapse(cat.id)}
                    aria-expanded={!isCollapsed}
                    aria-label={`${cat.name} category, ${isCollapsed ? "collapsed" : "expanded"}`}
                    className="kc-interactive flex w-full items-center gap-1 px-4 py-1 text-xs font-bold uppercase"
                    style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)", background: "none", border: "none", cursor: "pointer" }}
                  >
                    <span aria-hidden="true" style={{ display: "inline-block", transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out)" }}>▾</span>
                    <span className="truncate">{cat.name}</span>
                  </button>
                  {!isCollapsed && chans.map(renderChannel)}
                </div>
              );
            })}

            {/* Voice channels */}
            {voiceChannels.length > 0 && (
              <div className="kc-voice-section">
                <div
                  className="kc-voice-section-title px-4 py-1 text-xs font-bold uppercase"
                  style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
                >
                  Voice Channels
                </div>
                {voiceChannels.map((ch) => {
                  const active = activeVoiceChannelId === ch.id;
                  const participants = voiceParticipantsByChannel?.get(ch.id) ?? [];
                  return (
                    <VoiceChannelRow
                      key={ch.id}
                      name={ch.name}
                      active={active}
                      participants={participants}
                      participantCount={active ? Math.max(voiceParticipantCount, participants.length) : participants.length}
                      onJoin={(opts) => onJoinVoice(ch, opts)}
                    />
                  );
                })}
              </div>
            )}
          </>
        ) : (
          // DMs
          <div>
            <div
              className="flex items-center justify-between px-4 py-1 text-xs font-bold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
            >
              <span>Direct Messages</span>
              <span className="flex items-center gap-2">
                {onCreatePrivateDmLink && (
                  <button
                    type="button"
                    onClick={onCreatePrivateDmLink}
                    className="kc-interactive text-base leading-none"
                    style={{ color: "var(--text-muted)" }}
                    title="Create one-time private DM link"
                    aria-label="Create one-time private DM link"
                  >
                    ⛓
                  </button>
                )}
                {onFindPeople && (
                  <button
                    type="button"
                    onClick={onFindPeople}
                    className="kc-interactive text-lg leading-none"
                    style={{ color: "var(--text-muted)" }}
                    title="Find people"
                    aria-label="Find people"
                  >
                    +
                  </button>
                )}
              </span>
            </div>

            {dms.length === 0 ? (
              <div className="kc-empty-dm-card mx-3 my-4 text-center" style={{ color: "var(--text-muted)" }}>
                <div className="kc-empty-dm-card__icon" aria-hidden>⛓</div>
                <p className="text-sm font-bold" style={{ color: "var(--text-secondary)" }}>No conversations yet.</p>
                <p className="mt-1 text-xs">Find someone by username or create a one-time private DM link.</p>
                <div className="mt-3 flex flex-col gap-2">
                  {onFindPeople && (
                    <button
                      type="button"
                      onClick={onFindPeople}
                      className="kc-interactive rounded-full px-3 py-2 text-sm font-semibold"
                      style={{ background: "var(--accent)", color: "var(--bg-base)", border: "none" }}
                    >
                      Find people
                    </button>
                  )}
                  {onCreatePrivateDmLink && (
                    <button
                      type="button"
                      onClick={onCreatePrivateDmLink}
                      className="kc-interactive rounded-full px-3 py-2 text-sm font-semibold"
                      style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "1px solid color-mix(in oklch, var(--text-primary) 7%, transparent)" }}
                    >
                      Create private link
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {dms.some((dm) => pinnedDmIds.has(dm.id)) && (
                  <div className="mb-2">
                    <div
                      className="px-4 pb-1 pt-2 text-[10px] font-bold uppercase"
                      style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
                    >
                      Pinned
                    </div>
                    {dms.filter((dm) => pinnedDmIds.has(dm.id)).map(renderDmRow)}
                  </div>
                )}
                {dms.some((dm) => !pinnedDmIds.has(dm.id)) && dms.some((dm) => pinnedDmIds.has(dm.id)) && (
                  <div
                    className="px-4 pb-1 pt-1 text-[10px] font-bold uppercase"
                    style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
                  >
                    Recent
                  </div>
                )}
                {dms.filter((dm) => !pinnedDmIds.has(dm.id)).map(renderDmRow)}
              </>
            )}
          </div>
        )}
        {server && showActivationChecklist && activationState && onDismissActivationChecklist && (
          <ActivationChecklist
            state={activationState}
            serverName={server.name}
            onInvite={onInvite}
            onJoinVoice={firstVoiceChannel ? () => onJoinVoice(firstVoiceChannel, { muted: true }) : undefined}
            onDismiss={onDismissActivationChecklist}
          />
        )}
      </div>

      {/* User info bar */}
      {currentUser && (
        <UserPanel
          currentUser={currentUser}
          connStatus={connStatus}
          myStatus={myStatus}
          onSetStatus={onSetStatus}
          myActivity={myActivity}
          onSetActivity={onSetActivity}
          privacyMode={privacyMode}
          onLogout={onLogout}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}

/** A small crossed-out bell: this chat is muted. */
function MutedMark() {
  return (
    <span className="kc-muted-mark flex-shrink-0" role="img" aria-label="Muted" title="Muted">
      <Icon name="bellOff" size={14} />
    </span>
  );
}

function ChannelRow({
  icon, name, isSelected, unreadCount = 0, hasMention = false, muted = false, imported = false, onClick,
}: {
  icon: React.ReactNode;
  name: string;
  isSelected: boolean;
  unreadCount?: number;
  hasMention?: boolean;
  /** Muted (or in a muted space): looks quieter and shows no unread number, though an
   *  @mention still shows, as in Discord. */
  muted?: boolean;
  imported?: boolean;
  onClick: () => void;
}) {
  const hasUnread = !muted && unreadCount > 0 && !isSelected;
  const showMention = hasMention && !isSelected;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "page" : undefined}
      className={`kc-channel-row kc-interactive mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 px-2 py-1 text-left text-sm${isSelected ? " is-selected" : ""}${hasUnread || showMention ? " has-unread" : ""}${muted ? " is-muted" : ""}`}
    >
      <span className="kc-channel-row__icon" aria-hidden="true">{icon}</span>
      <span className="truncate flex-1">{name}</span>
      {muted && <MutedMark />}
      {isSelected && <span className="kc-channel-row__active-dot" aria-hidden="true" />}
      {imported && (
        <span
          className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{ background: "color-mix(in oklch, var(--gold, #f59e0b) 18%, transparent)", color: "var(--gold, #f59e0b)" }}
          title="Imported from Discord — not end-to-end encrypted"
          aria-label="Imported from Discord, not end-to-end encrypted"
        >
          Not E2E
        </span>
      )}
      {showMention ? (
        <span
          className="flex-shrink-0 rounded-full px-1.5 text-xs font-bold"
          style={{ background: "var(--danger-fill)", color: "#fff", minWidth: 18, textAlign: "center" }}
          aria-label="You were mentioned"
        >
          @
        </span>
      ) : hasUnread ? (
        <span
          className="flex-shrink-0 rounded-full px-1.5 text-xs font-bold"
          style={{ background: "var(--accent)", color: "var(--bg-base)", minWidth: 18, textAlign: "center", boxShadow: "0 0 10px color-mix(in oklch, var(--accent) 42%, transparent)" }}
          aria-label={`${unreadCount} unread`}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}

function VoiceChannelRow({
  name, active, participantCount, participants, onJoin,
}: {
  name: string;
  active: boolean;
  participantCount: number;
  participants: VoiceSidebarParticipant[];
  onJoin: (opts?: { muted?: boolean; video?: boolean }) => void;
}) {
  const displayName = /^general(?:\s+voice)?$/i.test(name.trim()) ? "Voice" : name;
  const hasParticipants = participantCount > 0;
  const participantNames = participants.map((p) => p.user.display_name || p.user.username);
  const previewNames = participantNames.slice(0, 3).join(", ");
  const overflowCount = Math.max(0, participantNames.length - 3);
  const liveLabel = participantCount === 1 && participantNames[0]
    ? `${participantNames[0]} is live`
    : participantCount > 1
      ? `${participantCount} people live`
      : "";
  const joinLabel = active
    ? "In call"
    : participantCount === 1 && participantNames[0]
      ? `Join ${participantNames[0]}`
      : participantCount > 1
        ? "Join them"
        : "Join";
  const title = active
    ? `You're in ${displayName}`
    : hasParticipants
      ? `${previewNames}${overflowCount ? ` +${overflowCount} more` : ""} in ${displayName}. Click to preview before joining.`
      : `Join ${displayName}`;
  const [previewOpen, setPreviewOpen] = useState(false);
  const joinNow = (opts?: { muted?: boolean; video?: boolean }) => {
    setPreviewOpen(false);
    onJoin(opts);
  };

  return (
    <div className="kc-voice-channel" data-testid="voice-channel-row">
      <button
        type="button"
        onClick={() => {
          if (!active && hasParticipants) setPreviewOpen((v) => !v);
          else joinNow();
        }}
        className="kc-voice-row kc-interactive mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm"
        style={{
          borderRadius: "var(--radius-md)", border: "none",
          background: active ? "color-mix(in oklch, var(--green) 12%, transparent)" : "transparent",
          color: active ? "var(--text-primary)" : hasParticipants ? "var(--text-secondary)" : "var(--text-muted)",
          fontWeight: active || hasParticipants ? 650 : 400,
          boxShadow: active ? "inset 3px 0 0 var(--green)" : undefined,
        }}
        title={title}
        aria-label={hasParticipants ? `${displayName}, ${liveLabel}, ${joinLabel}` : `${displayName}, empty voice channel, join voice`}
      >
        <SpeakerIcon />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{displayName}</span>
          {hasParticipants && !active && <span className="kc-voice-live-copy block truncate">{liveLabel}</span>}
        </span>
        {hasParticipants && (
          <span
            className="kc-voice-count flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
            style={{
              background: active ? "linear-gradient(135deg, var(--text-primary), var(--text-muted))" : "color-mix(in oklch, var(--green) 16%, transparent)",
              color: active ? "var(--bg-base)" : "var(--green)",
              boxShadow: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)",
            }}
          >
            <span className="kc-pulse" style={{ width: 6, height: 6, background: active ? "#fff" : "var(--green)" }} />
            {participantCount}
          </span>
        )}
        {!active && <span className="kc-voice-join text-xs font-semibold" style={{ color: "var(--accent)" }}>{joinLabel}</span>}
      </button>
      {previewOpen && !active && hasParticipants && (
        <div className="kc-voice-join-preview mx-3 mb-1 mt-1" role="group" aria-label={`Join ${displayName} preview`}>
          <div className="kc-voice-join-preview__title">Ready to join?</div>
          <div className="kc-voice-join-preview__copy">
            {previewNames}{overflowCount ? ` +${overflowCount} more` : ""} {participantCount === 1 ? "is" : "are"} already inside. Camera starts off.
          </div>
          <div className="kc-voice-join-preview__actions">
            <button type="button" className="kc-voice-preview-btn kc-voice-preview-btn--primary" onClick={() => joinNow({ muted: false, video: false })}>Join</button>
            <button type="button" className="kc-voice-preview-btn" onClick={() => joinNow({ muted: true, video: false })}>Join muted</button>
            <button type="button" className="kc-voice-preview-btn kc-voice-preview-btn--ghost" onClick={() => setPreviewOpen(false)} aria-label="Close join preview">Cancel</button>
          </div>
        </div>
      )}
      {participants.length > 0 && (
        <div className="kc-voice-participants mx-3 mb-1 mt-0.5" aria-label={`People in ${displayName}`}>
          {participants.slice(0, 6).map((p) => {
            const label = p.user.display_name || p.user.username;
            const status = p.screen ? "sharing screen" : p.video ? "camera on" : p.listenOnly ? "listening" : p.muted ? "muted" : "in call";
            return (
              <div key={p.user_id} data-testid="voice-channel-participant" className="kc-voice-participant">
                <div
                  className="kc-voice-participant-avatar"
                  style={{
                    backgroundImage: p.user.avatar_url ? `url(${p.user.avatar_url})` : undefined,
                  }}
                  aria-hidden="true"
                >
                  {!p.user.avatar_url && <AvatarMark />}
                </div>
                <span className="kc-voice-participant-name">{label}{p.isSelf ? " (you)" : ""}</span>
                <span className="kc-voice-participant-status" title={status} aria-label={status}>
                  {p.screen ? "▣" : p.video ? "◉" : p.listenOnly ? "♪" : p.muted ? "⌁" : "●"}
                </span>
              </div>
            );
          })}
          {participants.length > 6 && (
            <div className="kc-voice-participant kc-voice-participant--more">+{participants.length - 6} more</div>
          )}
        </div>
      )}
    </div>
  );
}
