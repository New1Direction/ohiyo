import { useState } from "react";
import type { PublicUser } from "../api";
import type { Activity } from "../gateway";
import { ModalShell } from "./ModalShell";
import { AvatarMark } from "./BirdMark";
import { TimeoutDialog } from "./moderation/TimeoutDialog";
import { BanDialog } from "./moderation/BanDialog";
import { timeoutEnds } from "../lib/moderation";
import { hoistGroups, nameColors, paintRoleColor, type SpaceRoles } from "../lib/roleColors";
import "./roles.css";
import "./moderation/moderation.css";

type Props = {
  members: PublicUser[];
  ownerId: string;
  currentUserId: string;
  onlineUsers: Set<string>;
  idleUsers?: Set<string>;
  activities: Map<string, Activity>;
  voiceMembers: Map<string, string>;
  onJoinVoice: (channelId: string) => void;
  onOpenDm?: (user: PublicUser) => void | Promise<void>;
  canKick: boolean;
  canBan: boolean;
  /** May time members out (Time out members). */
  canTimeout?: boolean;
  /** Members timed out right now: when each time out ends (unix seconds). */
  timeouts?: ReadonlyMap<string, number>;
  canManageRoles: boolean;
  onManageRoles: () => void;
  /** The space's roles and who holds them: names take role colours, and "show separately"
   *  roles get their own sections. */
  space?: SpaceRoles;
  onKick: (userId: string) => void;
  /** Ban, with the choices from the ban dialog; throws to keep the dialog open with why. */
  onBan: (userId: string, choice: { reason: string; deleteMessageSeconds: number }) => Promise<void>;
  /** Time a member out; throws to keep the dialog open with why. */
  onTimeout?: (userId: string, seconds: number, reason: string) => Promise<void>;
  onRemoveTimeout?: (userId: string) => Promise<void>;
  onClose: () => void;
};

type Pending = { kind: "timeout" | "ban"; member: PublicUser };

export const ACTIVITY_ICON: Record<string, string> = {
  playing: "🎮", watching: "📺", working: "💼", listening: "🎧",
};
export const ACTIVITY_VERB: Record<string, string> = {
  playing: "Playing", watching: "Watching", working: "Working on", listening: "Listening to",
};

/** A compact "🎮 Playing X" rich-presence line. */
export function ActivityLine({ activity }: { activity: Activity }) {
  return (
    <div className="truncate text-xs" style={{ color: "var(--accent)", fontWeight: 600 }}>
      {ACTIVITY_ICON[activity.kind] ?? "•"} {ACTIVITY_VERB[activity.kind] ?? ""} {activity.name}
      {activity.details ? (
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> — {activity.details}</span>
      ) : null}
    </div>
  );
}

/** Server member list. Moderation actions appear per your permissions. */
export function MembersModal({
  members, ownerId, currentUserId, onlineUsers, idleUsers, activities, voiceMembers, onJoinVoice, onOpenDm, canKick, canBan,
  canTimeout = false, timeouts, canManageRoles, onManageRoles, space, onKick, onBan, onTimeout, onRemoveTimeout, onClose,
}: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [dmBusyId, setDmBusyId] = useState<string | null>(null);
  // A time out or ban being decided: its dialog takes the list's place until it's done.
  const [pending, setPending] = useState<Pending | null>(null);
  const [liftingId, setLiftingId] = useState<string | null>(null);
  const canModerate = canKick || canBan;
  const sorted = [...members].sort((a, b) => {
    if (a.id === ownerId) return -1;
    if (b.id === ownerId) return 1;
    return a.display_name.localeCompare(b.display_name);
  });

  if (pending?.kind === "timeout" && onTimeout) {
    const { member } = pending;
    return (
      <TimeoutDialog
        name={member.display_name}
        onConfirm={async (seconds, reason) => {
          await onTimeout(member.id, seconds, reason);
          setPending(null);
        }}
        onClose={() => setPending(null)}
      />
    );
  }
  if (pending?.kind === "ban") {
    const { member } = pending;
    return (
      <BanDialog
        name={member.display_name}
        onConfirm={async (choice) => {
          await onBan(member.id, choice);
          setPending(null);
        }}
        onClose={() => setPending(null)}
      />
    );
  }

  const colors = space ? nameColors(space) : new Map<string, string>();
  const groups: { label: string; roleId?: string; members: PublicUser[] }[] = space
    ? hoistGroups(sorted, space, new Set([...onlineUsers, currentUserId]))
    : [{ label: "", members: sorted }];
  const now = Date.now();
  const timedOutUntil = (id: string) => {
    const until = timeouts?.get(id);
    return until !== undefined && until * 1000 > now ? until : null;
  };

  return (
    <ModalShell onClose={onClose} labelledBy="kc-members-title" maxWidthClass="max-w-2xl" placement="side">
      <div className="kc-polish-hero flex items-center justify-between gap-2">
        <div>
          <div className="kc-polish-kicker">Space roster</div>
          <h2
            id="kc-members-title"
            className="kc-polish-title"
            style={{ fontSize: "var(--text-2xl)" }}
          >
            Members · {members.length}
          </h2>
        </div>
        {canManageRoles && (
          <button
            type="button"
            onClick={onManageRoles}
            className="kc-interactive kc-polish-button flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold"
            style={{ color: "var(--accent)" }}
          >
            ⚙ Manage roles
          </button>
        )}
      </div>

      <div className="kc-members-list mt-4 flex flex-col gap-1" style={{ maxHeight: 380, overflowY: "auto" }}>
        {groups.map((group) => (
          <section key={group.roleId ?? (group.label || "all")} aria-label={group.label ? `${group.label} — ${group.members.length}` : undefined} className="flex flex-col gap-1">
            {group.label && (
              <h3 className="kc-members-group">
                {group.label} — {group.members.length}
              </h3>
            )}
        {group.members.map((m) => (
          <div
            key={m.id}
            className="kc-polish-row flex items-center gap-3 px-2.5 py-2"
          >
            <div className="relative flex-shrink-0">
              <div
                className="kc-polish-avatar flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold"
                style={{
                  color: "#fff",
                  backgroundImage: m.avatar_url ? `url(${m.avatar_url})` : undefined,
                  backgroundSize: "cover", backgroundPosition: "center",
                }}
              >
                {!m.avatar_url && <AvatarMark />}
              </div>
              {onlineUsers.has(m.id) && (
                <span
                  style={{
                    position: "absolute", right: -1, bottom: -1, width: 11, height: 11,
                    borderRadius: "var(--radius-full)",
                    background: idleUsers?.has(m.id) ? "var(--gold)" : "var(--green)",
                    border: "2.5px solid var(--bg-channel)",
                  }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold" style={{ color: colors.has(m.id) ? paintRoleColor(colors.get(m.id)!) : "var(--text-primary)" }}>
                  {m.display_name}
                </span>
                {m.id === ownerId && (
                  <span className="flex-shrink-0 text-xs" title="Owner" aria-label="Owner">👑</span>
                )}
              </div>
              {activities.get(m.id) ? (
                <ActivityLine activity={activities.get(m.id)!} />
              ) : (
                <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>@{m.username}</div>
              )}
              {timedOutUntil(m.id) !== null && (
                <span className="kc-mod-pill">Timed out until {timeoutEnds(timedOutUntil(m.id)!, now)}</span>
              )}
            </div>

            {canTimeout && m.id !== ownerId && m.id !== currentUserId && (
              timedOutUntil(m.id) !== null ? (
                onRemoveTimeout && (
                  <button
                    type="button"
                    aria-label={`Remove time out for ${m.display_name}`}
                    disabled={liftingId === m.id}
                    onClick={async () => {
                      setLiftingId(m.id);
                      try {
                        await onRemoveTimeout(m.id);
                      } finally {
                        setLiftingId(null);
                      }
                    }}
                    className="kc-interactive kc-polish-button flex-shrink-0 px-2 py-1 text-xs font-semibold"
                    style={{ borderRadius: "var(--radius-md)", color: "var(--text-primary)", cursor: "pointer" }}
                  >
                    End time out
                  </button>
                )
              ) : (
                onTimeout && (
                  <button
                    type="button"
                    aria-label={`Time out ${m.display_name}`}
                    onClick={() => {
                      setConfirmId(null);
                      setPending({ kind: "timeout", member: m });
                    }}
                    className="kc-interactive kc-polish-button flex-shrink-0 px-2 py-1 text-xs font-semibold"
                    style={{ borderRadius: "var(--radius-md)", color: "var(--text-secondary)", cursor: "pointer" }}
                    title="They can read, but can't post, react or join voice for a while"
                  >
                    Time out
                  </button>
                )
              )
            )}

            {onOpenDm && m.id !== currentUserId && (
              <button
                type="button"
                disabled={dmBusyId === m.id}
                onClick={async () => {
                  setDmBusyId(m.id);
                  try {
                    await onOpenDm(m);
                    onClose();
                  } catch {
                    setDmBusyId(null);
                  }
                }}
                className="kc-interactive kc-polish-button flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                style={{ color: "var(--accent)", cursor: dmBusyId === m.id ? "default" : "pointer" }}
                title={`Message ${m.display_name}`}
              >
                {dmBusyId === m.id ? "Opening…" : "Message"}
              </button>
            )}

            {voiceMembers.has(m.id) && m.id !== currentUserId && (
              <button
                type="button"
                onClick={() => onJoinVoice(voiceMembers.get(m.id)!)}
                className="kc-interactive kc-polish-button flex-shrink-0 flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
                style={{ color: "var(--green)", cursor: "pointer" }}
                title="Join their voice channel"
              >
                🔊 Join
              </button>
            )}

            {canModerate && m.id !== ownerId && m.id !== currentUserId && (
              confirmId === m.id ? (
                <span className="flex flex-shrink-0 items-center gap-1">
                  {canKick && (
                    <button
                      type="button"
                      onClick={() => { onKick(m.id); setConfirmId(null); }}
                      className="kc-interactive kc-polish-button px-2 py-1 text-xs font-semibold"
                      style={{ borderRadius: "var(--radius-md)", color: "var(--text-primary)", cursor: "pointer" }}
                      title="Remove — they can rejoin via invite"
                    >
                      Kick
                    </button>
                  )}
                  {canBan && (
                    <button
                      type="button"
                      onClick={() => { setConfirmId(null); setPending({ kind: "ban", member: m }); }}
                      className="px-2 py-1 text-xs font-semibold"
                      style={{ borderRadius: "var(--radius-md)", background: "var(--danger-fill)", color: "#fff", border: "none", cursor: "pointer" }}
                      title="Ban — removed and blocked from rejoining"
                    >
                      Ban
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="kc-interactive kc-polish-button px-2 py-1 text-xs font-semibold"
                    style={{ borderRadius: "var(--radius-md)", color: "var(--text-secondary)", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(m.id)}
                  aria-label={`Remove ${m.display_name}`}
                  className="kc-interactive kc-polish-button kc-polish-button--danger flex-shrink-0 px-2 py-1 text-xs font-semibold"
                  style={{ borderRadius: "var(--radius-md)", color: "var(--danger)", cursor: "pointer" }}
                >
                  Remove
                </button>
              )
            )}
          </div>
        ))}
          </section>
        ))}
      </div>
    </ModalShell>
  );
}
