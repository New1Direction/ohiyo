import type { UserProfile } from "../api";

/** The fields the profile card renders — shared by the hover popover and the
 *  live editor preview (container/presentational split). */
export type ProfileCardData = Pick<
  UserProfile,
  | "display_name"
  | "username"
  | "pronouns"
  | "banner_color"
  | "custom_status"
  | "bio"
  | "avatar_url"
  | "last_active_at"
  | "social_github"
  | "social_twitter"
  | "social_youtube"
  | "social_twitch"
  | "social_steam"
  | "social_spotify"
>;

/** Compact "last seen" label from a unix timestamp. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type SocialLink = { key: keyof ProfileCardData; label: string; icon: string; buildUrl: (val: string) => string };

const SOCIAL_LINKS: SocialLink[] = [
  { key: "social_github", label: "GitHub", icon: "🐙", buildUrl: (v) => `https://github.com/${v}` },
  { key: "social_twitter", label: "X / Twitter", icon: "🐦", buildUrl: (v) => `https://x.com/${v.replace(/^@/, "")}` },
  { key: "social_youtube", label: "YouTube", icon: "▶️", buildUrl: (v) => (v.startsWith("http") ? v : `https://youtube.com/${v}`) },
  { key: "social_twitch", label: "Twitch", icon: "🟣", buildUrl: (v) => `https://twitch.tv/${v}` },
  { key: "social_steam", label: "Steam", icon: "🎮", buildUrl: (v) => `https://steamcommunity.com/id/${v}` },
  { key: "social_spotify", label: "Spotify", icon: "🎵", buildUrl: (v) => (v.startsWith("http") ? v : `https://open.spotify.com/artist/${v}`) },
];

/** Presentational profile card body (banner + avatar + details + socials). The
 *  caller owns positioning/portal; links are inert in preview mode. */
export function ProfileCardView({ data, preview = false }: { data: ProfileCardData; preview?: boolean }) {
  const bannerColor = data.banner_color ?? "#5865f2";
  const initial = (data.display_name || "?")[0]?.toUpperCase();
  const hasSocials = SOCIAL_LINKS.some((s) => data[s.key]);

  return (
    <div>
      {/* Banner */}
      <div style={{ height: 72, background: bannerColor }} />

      <div style={{ padding: "0 16px" }}>
        {/* Avatar — overlaps banner */}
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
              overflow: "hidden",
            }}
          >
            {data.avatar_url ? (
              <img
                src={data.avatar_url}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              initial
            )}
          </div>
        </div>

        <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text-primary)", lineHeight: 1.2 }}>
          {data.display_name || "Your name"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>@{data.username || "username"}</div>

        {data.pronouns && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{data.pronouns}</div>
        )}
        {data.last_active_at != null && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
            🕒 Active {relativeTime(data.last_active_at)}
          </div>
        )}
        {data.custom_status && (
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
            💬 {data.custom_status}
          </div>
        )}
        {data.bio && (
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
              whiteSpace: "pre-wrap",
            }}
          >
            {data.bio}
          </div>
        )}

        {hasSocials && (
          <div style={{ borderTop: "1px solid var(--bg-hover)", paddingTop: 8, marginTop: 4, paddingBottom: 12 }}>
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
                const val = data[s.key] as string | null | undefined;
                if (!val) return null;
                const row = (
                  <>
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
                  </>
                );
                const style: React.CSSProperties = {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                  background: "var(--bg-input)",
                };
                // Inert in the editor preview; real link in the popover.
                return preview ? (
                  <div key={s.key} style={style}>
                    {row}
                  </div>
                ) : (
                  <a key={s.key} href={s.buildUrl(val)} target="_blank" rel="noopener noreferrer" style={style}>
                    {row}
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
