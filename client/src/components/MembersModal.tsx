import { useState } from "react";
import type { PublicUser } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  members: PublicUser[];
  ownerId: string;
  currentUserId: string;
  onlineUsers: Set<string>;
  canKick: boolean;
  canBan: boolean;
  canManageRoles: boolean;
  onManageRoles: () => void;
  onKick: (userId: string) => void;
  onBan: (userId: string) => void;
  onClose: () => void;
};

/** Server member list. Moderation actions appear per your permissions. */
export function MembersModal({
  members, ownerId, currentUserId, onlineUsers, canKick, canBan, canManageRoles, onManageRoles, onKick, onBan, onClose,
}: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const canModerate = canKick || canBan;
  const sorted = [...members].sort((a, b) => {
    if (a.id === ownerId) return -1;
    if (b.id === ownerId) return 1;
    return a.display_name.localeCompare(b.display_name);
  });

  return (
    <ModalShell onClose={onClose} labelledBy="kc-members-title">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="kc-members-title"
          style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
        >
          Members · {members.length}
        </h2>
        {canManageRoles && (
          <button
            type="button"
            onClick={onManageRoles}
            className="kc-interactive flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold"
            style={{ background: "color-mix(in oklch, var(--accent) 14%, transparent)", color: "var(--accent)" }}
          >
            ⚙ Manage roles
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-1" style={{ maxHeight: 380, overflowY: "auto" }}>
        {sorted.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 px-2.5 py-2"
            style={{ borderRadius: "var(--radius-md)" }}
          >
            <div className="relative flex-shrink-0">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold"
                style={{
                  background: "var(--accent)", color: "#fff",
                  backgroundImage: m.avatar_url ? `url(${m.avatar_url})` : undefined,
                  backgroundSize: "cover", backgroundPosition: "center",
                }}
              >
                {!m.avatar_url && (m.display_name[0] ?? "?").toUpperCase()}
              </div>
              {onlineUsers.has(m.id) && (
                <span
                  style={{
                    position: "absolute", right: -1, bottom: -1, width: 11, height: 11,
                    borderRadius: "var(--radius-full)", background: "var(--green)",
                    border: "2.5px solid var(--bg-channel)",
                  }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  {m.display_name}
                </span>
                {m.id === ownerId && (
                  <span className="flex-shrink-0 text-xs" title="Owner" aria-label="Owner">👑</span>
                )}
              </div>
              <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>@{m.username}</div>
            </div>

            {canModerate && m.id !== ownerId && m.id !== currentUserId && (
              confirmId === m.id ? (
                <span className="flex flex-shrink-0 items-center gap-1">
                  {canKick && (
                    <button
                      type="button"
                      onClick={() => { onKick(m.id); setConfirmId(null); }}
                      className="kc-interactive px-2 py-1 text-xs font-semibold"
                      style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-primary)", border: "none", cursor: "pointer" }}
                      title="Remove — they can rejoin via invite"
                    >
                      Kick
                    </button>
                  )}
                  {canBan && (
                    <button
                      type="button"
                      onClick={() => { onBan(m.id); setConfirmId(null); }}
                      className="px-2 py-1 text-xs font-semibold"
                      style={{ borderRadius: "var(--radius-md)", background: "var(--danger)", color: "#fff", border: "none", cursor: "pointer" }}
                      title="Ban — removed and blocked from rejoining"
                    >
                      Ban
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="kc-interactive px-2 py-1 text-xs font-semibold"
                    style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(m.id)}
                  aria-label={`Remove ${m.display_name}`}
                  className="kc-interactive flex-shrink-0 px-2 py-1 text-xs font-semibold"
                  style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--danger)", border: "none", cursor: "pointer" }}
                >
                  Remove
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
