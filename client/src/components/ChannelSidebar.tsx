import { useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Channel, ServerWithChannels, PublicUser } from "../api";
import type { ConnectionStatus, Activity } from "../gateway";

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
  unread?: Record<string, number>;
  mentionChannels?: Set<string>;
  myStatus?: string | null;
  onSetStatus?: (status: string) => void;
  myActivity?: Activity | null;
  onSetActivity?: (activity: Activity | null) => void;
  canManageChannels?: boolean;
  canManageServer?: boolean;
  onOpenCategories?: () => void;
  onSelectChannel: (channel: Channel) => void;
  onJoinVoice: (channel: Channel) => void;
  onCreateChannel: (name: string) => void;
  onSetServerIcon?: (serverId: string, file: File) => void | Promise<void>;
  onInvite?: () => void;
  onFindPeople?: () => void;
  onOpenEvents?: () => void;
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

const STATUS_META: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: "Connected", color: "var(--green)" },
  connecting: { label: "Connecting…", color: "#E8A23D" },
  disconnected: { label: "Reconnecting you now…", color: "var(--danger)" },
};

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
  unread,
  mentionChannels,
  myStatus,
  onSetStatus,
  myActivity,
  onSetActivity,
  canManageChannels,
  canManageServer,
  onOpenCategories,
  onSelectChannel,
  onJoinVoice,
  onCreateChannel,
  onSetServerIcon,
  onInvite,
  onFindPeople,
  onOpenEvents,
  onLogout,
  onOpenSettings,
}: Props) {
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [editingStatus, setEditingStatus] = useState(false);
  const serverIconInputRef = useRef<HTMLInputElement>(null);
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
  // Guards the status input's onBlur from re-saving after Enter, or saving on Escape.
  const statusHandledRef = useRef(false);

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
  const selfOnline = connStatus === "connected";

  const renderChannel = (ch: Channel) => (
    <ChannelRow
      key={ch.id}
      icon={<HashIcon />}
      name={ch.name}
      isSelected={selectedChannelId === ch.id}
      unreadCount={unread?.[ch.id] ?? 0}
      hasMention={mentionChannels?.has(ch.id) ?? false}
      imported={Boolean(ch.imported)}
      onClick={() => onSelectChannel(ch)}
    />
  );

  const renderDmRow = (dm: Channel) => {
    const other = dmUsers[dm.id];
    const label = other?.display_name ?? other?.username ?? (dm.channel_type === "group_dm" ? dm.name || "Group DM" : "Direct Message");
    const online = other ? onlineUsers.has(other.id) : false;
    const isSel = selectedChannelId === dm.id;
    const unreadCount = unread?.[dm.id] ?? 0;
    const hasUnread = unreadCount > 0 && !isSel;
    const showMention = (mentionChannels?.has(dm.id) ?? false) && !isSel;
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
                background: "linear-gradient(135deg, var(--text-primary), var(--text-muted))", color: "var(--bg-base)",
                boxShadow: isSel ? "0 0 0 2px color-mix(in oklch, var(--accent) 22%, transparent)" : undefined,
                backgroundImage: other?.avatar_url ? `url(${other.avatar_url})` : undefined,
                backgroundSize: "cover", backgroundPosition: "center",
              }}
            >
              {!other?.avatar_url && label[0]?.toUpperCase()}
            </div>
            {online && (
              <OnlineDot
                color={other && idleUsers?.has(other.id) ? "var(--gold)" : "var(--green)"}
              />
            )}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
          {showMention ? (
            <span
              className="flex-shrink-0 rounded-full px-1.5 text-xs font-bold"
              style={{ background: "var(--danger)", color: "#fff", minWidth: 18, textAlign: "center" }}
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
            <div className="truncate" style={{ fontFamily: "var(--font-display)", fontWeight: 750, fontSize: "var(--text-lg)", color: "var(--text-primary)" }}>{server ? server.name : "Direct Messages"}</div>
            <div className="truncate text-[11px] font-semibold" style={{ color: "var(--text-muted)", letterSpacing: "0.02em" }}>{server ? "Private space" : "Your conversations"}</div>
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          {server && canManageServer && onSetServerIcon && (
            <>
              <button
                type="button"
                onClick={() => serverIconInputRef.current?.click()}
                title="Change server logo"
                aria-label="Change server logo"
                className="kc-sidebar-action kc-interactive flex h-7 w-7 items-center justify-center rounded-full text-sm"
                style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "none", cursor: "pointer" }}
              >
                <Icon name="edit" size={14} />
              </button>
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
            </>
          )}
          {server && onOpenEvents && (
            <button
              onClick={onOpenEvents}
              title="Events"
              aria-label="Events"
              className="kc-sidebar-action kc-interactive flex h-7 w-7 items-center justify-center rounded-full text-base"
              style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "none", cursor: "pointer" }}
            >
              <Icon name="calendar" size={16} />
            </button>
          )}
          {server && onInvite && (
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
          )}
        </div>
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
                {voiceChannels.map((ch) => (
                  <VoiceChannelRow
                    key={ch.id}
                    name={ch.name}
                    active={activeVoiceChannelId === ch.id}
                    participantCount={activeVoiceChannelId === ch.id ? voiceParticipantCount : 0}
                    onJoin={() => onJoinVoice(ch)}
                  />
                ))}
              </div>
            )}

            <div className="kc-sidebar-hint mx-3 mt-5">
              <div className="kc-sidebar-hint-title">Ready when you are</div>
              <p>Send a message, hop into voice, or invite a friend.</p>
            </div>
          </>
        ) : (
          // DMs
          <div>
            <div
              className="flex items-center justify-between px-4 py-1 text-xs font-bold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
            >
              <span>Direct Messages</span>
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
            </div>

            {dms.length === 0 ? (
              <div className="px-4 py-6 text-center" style={{ color: "var(--text-muted)" }}>
                <p className="text-xs">No conversations yet.</p>
                {onFindPeople && (
                  <button
                    type="button"
                    onClick={onFindPeople}
                    className="kc-interactive mt-2 text-sm font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    Find people →
                  </button>
                )}
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
      </div>

      {/* User info bar */}
      {currentUser && (
        <div
          className="kc-user-panel flex items-center gap-2.5 px-2 py-3"
          style={{ background: "var(--bg-base)", borderTop: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)" }}
        >
          <button
            type="button"
            onClick={() => onSetStatus && setEditingStatus(true)}
            className="kc-user-avatar-btn relative flex-shrink-0"
            style={{ border: "none", background: "transparent", padding: 0, cursor: onSetStatus ? "pointer" : "default" }}
            aria-label="Edit status"
            title="Edit status"
          >
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold"
              style={{
                background: "linear-gradient(135deg, var(--text-primary), var(--text-muted))", color: "var(--bg-base)",
                boxShadow: "0 0 0 2px color-mix(in oklch, var(--accent) 22%, transparent)",
                backgroundImage: currentUser.avatar_url ? `url(${currentUser.avatar_url})` : undefined,
                backgroundSize: "cover", backgroundPosition: "center",
              }}
            >
              {!currentUser.avatar_url && currentUser.display_name[0]?.toUpperCase()}
            </div>
            <OnlineDot color={selfOnline ? "var(--green)" : "#E8A23D"} />
          </button>
          <div className="min-w-0 flex-1 leading-tight">
            <button
              type="button"
              onClick={() => onSetStatus && setEditingStatus(true)}
              className="kc-interactive block w-full truncate text-left text-sm font-semibold"
              style={{ color: "var(--text-primary)", background: "none", border: "none", cursor: onSetStatus ? "pointer" : "default", padding: 0 }}
              title="Edit status"
            >
              {currentUser.display_name}
            </button>
            {editingStatus ? (
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- inline status editor opens on user action; focusing immediately is expected
                autoFocus
                defaultValue={myStatus ?? ""}
                maxLength={80}
                placeholder="Set your vibe"
                onFocus={() => { statusHandledRef.current = false; }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    statusHandledRef.current = true; // saving now; don't re-save on blur
                    onSetStatus?.((e.target as HTMLInputElement).value);
                    setEditingStatus(false);
                  } else if (e.key === "Escape") {
                    statusHandledRef.current = true; // cancel — don't save on blur
                    setEditingStatus(false);
                  }
                }}
                onBlur={(e) => {
                  if (!statusHandledRef.current) onSetStatus?.(e.target.value);
                  setEditingStatus(false);
                }}
                className="kc-user-status-input w-full bg-transparent text-xs outline-none"
                style={{ color: "var(--text-secondary)" }}
              />
            ) : (
              <button
                type="button"
                onClick={() => onSetStatus && setEditingStatus(true)}
                className="kc-interactive kc-user-status w-full truncate text-left text-xs"
                style={{
                  color: myStatus ? "var(--text-secondary)" : "var(--text-muted)",
                  background: "none", border: "none",
                  cursor: onSetStatus ? "pointer" : "default",
                }}
                title="Set a custom status"
              >
                {myStatus || (selfOnline ? "Set a status" : STATUS_META[connStatus].label)}
              </button>
            )}
            {onSetActivity && <ActivityComposer activity={myActivity ?? null} onSet={onSetActivity} />}
          </div>
          <div className="kc-user-actions flex flex-shrink-0 items-center gap-1">
            <button type="button" onClick={onOpenSettings} aria-label="Settings" className="kc-sidebar-action kc-interactive flex h-8 w-8 items-center justify-center rounded-full text-base" style={{ color: "var(--text-muted)", background: "transparent", border: "none" }} title="Settings (Ctrl+,)"><Icon name="settings" size={16} /></button>
            <button type="button" onClick={onLogout} aria-label="Log out" className="kc-sidebar-action kc-interactive flex h-8 w-8 items-center justify-center rounded-full text-base" style={{ color: "var(--text-muted)", background: "transparent", border: "none" }} title="Log out">⎋</button>
          </div>
        </div>
      )}
    </div>
  );
}

function OnlineDot({ color = "var(--green)" }: { color?: string }) {
  return (
    <span
      style={{
        position: "absolute", right: -1, bottom: -1, width: 11, height: 11,
        borderRadius: "var(--radius-full)", background: color,
        border: "2.5px solid var(--bg-sidebar)",
      }}
    />
  );
}

const ACTIVITY_KINDS = [
  { kind: "playing", icon: "🎮", verb: "Playing" },
  { kind: "watching", icon: "📺", verb: "Watching" },
  { kind: "working", icon: "💼", verb: "Working on" },
  { kind: "listening", icon: "🎧", verb: "Listening to" },
] as const;

/** Inline rich-presence setter shown under the user's name in the sidebar. */
function ActivityComposer({ activity, onSet }: { activity: Activity | null; onSet: (a: Activity | null) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("playing");
  const [name, setName] = useState("");

  if (activity && !open) {
    const meta = ACTIVITY_KINDS.find((k) => k.kind === activity.kind);
    return (
      <div className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: "var(--accent)", fontWeight: 600 }}>
        <span className="truncate">{meta?.icon ?? "•"} {meta?.verb ?? ""} {activity.name}</span>
        <button
          type="button"
          onClick={() => onSet(null)}
          aria-label="Clear activity"
          title="Clear activity"
          className="kc-interactive flex-shrink-0"
          style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}
        >
          ×
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="kc-interactive mt-0.5 text-left text-xs"
        style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
      >
        + Activity
      </button>
    );
  }
  const submit = () => {
    const n = name.trim();
    if (n) onSet({ kind, name: n });
    setOpen(false);
    setName("");
  };
  return (
    <div className="mt-0.5 flex items-center gap-1">
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        aria-label="Activity type"
        className="bg-transparent text-xs outline-none"
        style={{ color: "var(--text-secondary)" }}
      >
        {ACTIVITY_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>{k.icon} {k.verb}</option>
        ))}
      </select>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- inline composer opens on user action; focusing immediately is expected
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={128}
        placeholder="What are you up to?"
        aria-label="Activity name"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") setOpen(false);
        }}
        onBlur={submit}
        className="w-full bg-transparent text-xs outline-none"
        style={{ color: "var(--text-secondary)" }}
      />
    </div>
  );
}

function ChannelRow({
  icon, name, isSelected, unreadCount = 0, hasMention = false, imported = false, onClick,
}: {
  icon: React.ReactNode;
  name: string;
  isSelected: boolean;
  unreadCount?: number;
  hasMention?: boolean;
  imported?: boolean;
  onClick: () => void;
}) {
  const hasUnread = unreadCount > 0 && !isSelected;
  const showMention = hasMention && !isSelected;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "page" : undefined}
      className="kc-interactive mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 px-2 py-1 text-left text-sm"
      style={{
        border: "none",
        borderRadius: "var(--radius-md)",
        background: isSelected ? "color-mix(in oklch, var(--text-primary) 8%, transparent)" : "transparent",
        color: isSelected || hasUnread || showMention ? "var(--text-primary)" : "var(--text-muted)",
        fontWeight: isSelected || hasUnread || showMention ? 650 : 400,
        boxShadow: isSelected ? "inset 3px 0 0 var(--accent)" : undefined,
      }}
    >
      {icon}
      <span className="truncate flex-1">{name}</span>
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
          style={{ background: "var(--danger)", color: "#fff", minWidth: 18, textAlign: "center" }}
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
  name, active, participantCount, onJoin,
}: {
  name: string;
  active: boolean;
  participantCount: number;
  onJoin: () => void;
}) {
  const displayName = /^general(?:\s+voice)?$/i.test(name.trim()) ? "Voice" : name;

  return (
    <button
      type="button"
      onClick={onJoin}
      className="kc-voice-row kc-interactive mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm"
      style={{
        borderRadius: "var(--radius-md)", border: "none",
        background: active ? "color-mix(in oklch, var(--green) 12%, transparent)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        fontWeight: active ? 650 : 400,
        boxShadow: active ? "inset 3px 0 0 var(--green)" : undefined,
      }}
      title={active ? "You're in this call" : "Join voice"}
    >
      <SpeakerIcon />
      <span className="truncate flex-1 text-left">{displayName}</span>
      {active ? (
        <span
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
          style={{ background: "linear-gradient(135deg, var(--text-primary), var(--text-muted))", color: "var(--bg-base)", boxShadow: "0 0 0 1px color-mix(in oklch, var(--green) 32%, transparent)" }}
        >
          <span className="kc-pulse" style={{ width: 6, height: 6, background: "#fff" }} />
          {participantCount}
        </span>
      ) : (
        <span className="kc-voice-join text-xs font-semibold" style={{ color: "var(--accent)" }}>Join</span>
      )}
    </button>
  );
}
