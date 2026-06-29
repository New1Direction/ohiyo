import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FriendshipStatus, PublicUser, UserProfile } from "../api";
import { api } from "../api";
import { ProfileCardView } from "./ProfileCardView";

type Props = {
  userId: string;
  token: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  currentUserId?: string;
  onOpenDm?: (user: PublicUser) => void | Promise<void>;
  onBlockUser?: (user: PublicUser) => void | Promise<void>;
  onReportUser?: (user: PublicUser) => void | Promise<void>;
  onClose: () => void;
};

export function UserProfileCard({ userId, token, anchorRef, currentUserId, onOpenDm, onBlockUser, onReportUser, onClose }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [dmBusy, setDmBusy] = useState(false);
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendship, setFriendship] = useState<FriendshipStatus>("none");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setProfile(null);
    setFriendship("none");
    Promise.all([
      api.getPublicProfile(token, userId),
      api.getFriendship(token, userId).catch(() => ({ status: "none" as FriendshipStatus })),
    ])
      .then(([p, rel]) => {
        if (!alive) return;
        setProfile(p);
        setFriendship(rel.status);
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token, userId]);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const cardW = 300;
    const cardH = 420;
    let left = rect.right + 8;
    let top = rect.top;
    if (left + cardW > window.innerWidth) left = rect.left - cardW - 8;
    if (top + cardH > window.innerHeight) top = window.innerHeight - cardH - 8;
    if (top < 8) top = 8;
    setPos({ top, left });
  }, [anchorRef]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Move focus into the dialog on open and restore it to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  async function runFriendAction(action: "add" | "accept" | "remove") {
    if (!profile) return;
    setFriendBusy(true);
    try {
      if (action === "add") {
        const rel = await api.sendFriendRequest(token, profile.id);
        setFriendship(rel.status);
      } else if (action === "accept") {
        const rel = await api.acceptFriendRequest(token, profile.id);
        setFriendship(rel.status);
      } else {
        await api.deleteFriendship(token, profile.id);
        setFriendship("none");
      }
    } finally {
      setFriendBusy(false);
    }
  }

  const card = (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-label="User profile"
      tabIndex={-1}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 300,
        zIndex: 9999,
        borderRadius: "var(--radius-xl)",
        overflow: "hidden",
        boxShadow: "var(--shadow-lg)",
        background: "var(--bg-sidebar)",
        border: "1px solid var(--bg-hover)",
        outline: "none",
      }}
    >
      {loading ? (
        <>
          <div style={{ height: 72, background: "var(--bg-hover)" }} />
          <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>Loading…</div>
        </>
      ) : profile ? (
        <>
          <ProfileCardView data={profile} />
          {profile.id !== currentUserId && (
            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              {friendship === "pending_incoming" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <ActionButton busy={friendBusy} label="Accept" onClick={() => runFriendAction("accept")} primary />
                  <ActionButton busy={friendBusy} label="Decline" onClick={() => runFriendAction("remove")} />
                </div>
              ) : friendship === "pending_outgoing" ? (
                <ActionButton busy={friendBusy} label="Request Sent" onClick={() => runFriendAction("remove")} />
              ) : friendship === "friends" ? (
                <ActionButton busy={friendBusy} label="Friends ✓" onClick={() => runFriendAction("remove")} />
              ) : (
                <ActionButton busy={friendBusy} label="Add Friend" onClick={() => runFriendAction("add")} primary />
              )}
              {onOpenDm && (
                <ActionButton
                  busy={dmBusy}
                  label="Message"
                  primary={friendship === "friends"}
                  onClick={async () => {
                    setDmBusy(true);
                    try {
                      await onOpenDm({
                        id: profile.id,
                        username: profile.username,
                        display_name: profile.display_name,
                        avatar_url: profile.avatar_url,
                      });
                      onClose();
                    } catch {
                      setDmBusy(false);
                    }
                  }}
                />
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {onBlockUser && (
                  <ActionButton
                    busy={false}
                    label="Block"
                    danger
                    onClick={() => {
                      void onBlockUser({ id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url });
                      onClose();
                    }}
                  />
                )}
                {onReportUser && (
                  <ActionButton
                    busy={false}
                    label="Report"
                    danger
                    onClick={() => {
                      void onReportUser({ id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url });
                      onClose();
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ height: 72, background: "var(--bg-hover)" }} />
          <div style={{ padding: 16, fontSize: 13, color: "var(--danger)" }}>Failed to load profile</div>
        </>
      )}
    </div>
  );

  return createPortal(card, document.body);
}

function ActionButton({
  label,
  busy,
  primary = false,
  danger = false,
  onClick,
}: {
  label: string;
  busy: boolean;
  primary?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="kc-interactive"
      style={{
        width: "100%",
        border: "none",
        borderRadius: "var(--radius-md)",
        padding: "9px 12px",
        cursor: busy ? "default" : "pointer",
        background: primary ? "var(--accent)" : "var(--bg-input)",
        color: primary ? "#fff" : danger ? "var(--danger)" : "var(--text-primary)",
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {busy ? "Working…" : label}
    </button>
  );
}
