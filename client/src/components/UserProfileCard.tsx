import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UserProfile } from "../api";
import { api } from "../api";

/** Compact "last seen" label from a unix timestamp. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type SocialLink = {
  key: keyof UserProfile;
  label: string;
  icon: string;
  buildUrl: (val: string) => string;
};

const SOCIAL_LINKS: SocialLink[] = [
  { key: "social_github", label: "GitHub", icon: "🐙", buildUrl: (v) => `https://github.com/${v}` },
  { key: "social_twitter", label: "X / Twitter", icon: "🐦", buildUrl: (v) => `https://x.com/${v.replace(/^@/, "")}` },
  { key: "social_youtube", label: "YouTube", icon: "▶️", buildUrl: (v) => v.startsWith("http") ? v : `https://youtube.com/${v}` },
  { key: "social_twitch", label: "Twitch", icon: "🟣", buildUrl: (v) => `https://twitch.tv/${v}` },
  { key: "social_steam", label: "Steam", icon: "🎮", buildUrl: (v) => `https://steamcommunity.com/id/${v}` },
  { key: "social_spotify", label: "Spotify", icon: "🎵", buildUrl: (v) => v.startsWith("http") ? v : `https://open.spotify.com/artist/${v}` },
];

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
    api.getPublicProfile(token, userId).then((p) => {
      setProfile(p);
      setLoading(false);
    }).catch(() => setLoading(false));
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

  const bannerColor = profile?.banner_color ?? "#5865f2";
  const initial = (profile?.display_name ?? "?")[0]?.toUpperCase();

  const card = (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kc-profile-name"
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
      {/* Banner */}
      <div style={{ height: 72, background: bannerColor }} />

      {/* Avatar — overlaps banner */}
      <div style={{ padding: "0 16px" }}>
        <div style={{ marginTop: -28, marginBottom: 8, display: "inline-block" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
              border: "4px solid var(--bg-sidebar)",
              color: "#fff",
            }}
          >
            {loading ? "…" : initial}
          </div>
        </div>

        {loading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13, paddingBottom: 16 }}>Loading…</div>
        ) : profile ? (
          <>
            <div id="kc-profile-name" style={{ fontWeight: 700, fontSize: 16, color: "var(--text-primary)", lineHeight: 1.2 }}>
              {profile.display_name}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>
              @{profile.username}
            </div>
            {profile.pronouns && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                {profile.pronouns}
              </div>
            )}
            {profile.last_active_at && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                🕒 Active {relativeTime(profile.last_active_at)}
              </div>
            )}
            {profile.custom_status && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  background: "var(--bg-input)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  marginTop: 4,
                  marginBottom: 8,
                }}
              >
                💬 {profile.custom_status}
              </div>
            )}
            {profile.bio && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  borderTop: "1px solid var(--bg-hover)",
                  paddingTop: 8,
                  marginTop: 4,
                  marginBottom: 8,
                  lineHeight: 1.5,
                  maxHeight: 80,
                  overflowY: "auto",
                }}
              >
                {profile.bio}
              </div>
            )}

            {/* Social links */}
            {SOCIAL_LINKS.some((s) => profile[s.key]) && (
              <div
                style={{
                  borderTop: "1px solid var(--bg-hover)",
                  paddingTop: 8,
                  marginTop: 4,
                  paddingBottom: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    marginBottom: 6,
                    letterSpacing: "0.06em",
                  }}
                >
                  Connected Accounts
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {SOCIAL_LINKS.map((s) => {
                    const val = profile[s.key] as string | null;
                    if (!val) return null;
                    return (
                      <a
                        key={s.key}
                        href={s.buildUrl(val)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 6px",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          textDecoration: "none",
                          background: "var(--bg-input)",
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-secondary)";
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{s.icon}</span>
                        <span style={{ fontWeight: 500 }}>{s.label}</span>
                        <span
                          style={{
                            marginLeft: "auto",
                            color: "var(--text-muted)",
                            fontSize: 11,
                            maxWidth: 120,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {val}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: "var(--danger)", fontSize: 13, paddingBottom: 16 }}>Failed to load profile</div>
        )}
      </div>
    </div>
  );

  return createPortal(card, document.body);
}
