import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UserProfile } from "../api";
import { api } from "../api";
import { ProfileCardView } from "./ProfileCardView";

type Props = {
  userId: string;
  token: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

export function UserProfileCard({ userId, token, anchorRef, onClose }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    api
      .getPublicProfile(token, userId)
      .then((p) => {
        setProfile(p);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
        <ProfileCardView data={profile} />
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
