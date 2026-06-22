import type { ProfileTheme, UserProfile } from "../api";
import { safeHttpUrl } from "../lib/url";

/** The fields the profile card renders — shared by the hover popover and the
 *  live editor preview (container/presentational split). */
export type ProfileCardData = Pick<
  UserProfile,
  | "display_name"
  | "username"
  | "banner_color"
  | "banner_url"
  | "custom_status"
  | "bio"
  | "avatar_url"
  | "last_active_at"
  | "profile_theme"
  | "top_songs"
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

// Prefix-interpolated handles are `encodeURIComponent`-escaped so a crafted
// handle can't manipulate the path/host. Full-URL fields (YouTube/Spotify) are
// passed through verbatim here and validated with `safeHttpUrl` at render time.
const SOCIAL_LINKS: SocialLink[] = [
  { key: "social_github", label: "GitHub", icon: "🐙", buildUrl: (v) => `https://github.com/${encodeURIComponent(v)}` },
  { key: "social_twitter", label: "X / Twitter", icon: "🐦", buildUrl: (v) => `https://x.com/${encodeURIComponent(v.replace(/^@/, ""))}` },
  { key: "social_youtube", label: "YouTube", icon: "▶️", buildUrl: (v) => (v.startsWith("http") ? v : `https://youtube.com/${encodeURIComponent(v)}`) },
  { key: "social_twitch", label: "Twitch", icon: "🟣", buildUrl: (v) => `https://twitch.tv/${encodeURIComponent(v)}` },
  { key: "social_steam", label: "Steam", icon: "🎮", buildUrl: (v) => `https://steamcommunity.com/id/${encodeURIComponent(v)}` },
  { key: "social_spotify", label: "Spotify", icon: "🎵", buildUrl: (v) => (v.startsWith("http") ? v : `https://open.spotify.com/artist/${encodeURIComponent(v)}`) },
];

export const PROFILE_VIBES = {
  sunset: { label: "Sunset", a: "#ff7a45", b: "#ff4fd8", c: "#ffd166" },
  ocean: { label: "Ocean", a: "#38bdf8", b: "#2563eb", c: "#8b5cf6" },
  forest: { label: "Forest", a: "#34d399", b: "#15803d", c: "#facc15" },
  grape: { label: "Grape", a: "#a78bfa", b: "#7c3aed", c: "#f0abfc" },
  mono: { label: "Mono", a: "#d6d3d1", b: "#57534e", c: "#fafaf9" },
} as const;

export const PROFILE_PATTERNS = [
  { id: "none", label: "Clean" },
  { id: "stars", label: "Stars" },
  { id: "hearts", label: "Hearts" },
  { id: "bubbles", label: "Bubbles" },
] as const;

type ResolvedProfileVisuals = {
  vibe: NonNullable<ProfileTheme["vibe"]>;
  accent: string;
  pattern: NonNullable<ProfileTheme["pattern"]>;
  glow: boolean;
  emoji: string | null;
};

function cleanTheme(theme: ProfileTheme | null | undefined, bannerColor: string): ResolvedProfileVisuals {
  const vibe = theme?.vibe ?? "sunset";
  const preset = vibe !== "custom" ? PROFILE_VIBES[vibe as keyof typeof PROFILE_VIBES] ?? PROFILE_VIBES.sunset : null;
  return {
    vibe,
    accent: theme?.accent ?? preset?.a ?? bannerColor,
    pattern: theme?.pattern ?? "stars",
    glow: theme?.glow ?? true,
    emoji: theme?.emoji?.trim() ? theme.emoji.trim().slice(0, 2) : null,
  };
}

function gradientFor(theme: ReturnType<typeof cleanTheme>, fallback: string): string {
  if (theme.vibe === "custom") {
    return `radial-gradient(circle at 18% 12%, color-mix(in oklch, ${theme.accent} 72%, white) 0, transparent 34%), linear-gradient(135deg, ${theme.accent}, color-mix(in oklch, ${theme.accent} 58%, black))`;
  }
  const v = PROFILE_VIBES[theme.vibe as keyof typeof PROFILE_VIBES] ?? PROFILE_VIBES.sunset;
  return `radial-gradient(circle at 20% 15%, ${v.c} 0, transparent 30%), linear-gradient(135deg, ${v.a} 0%, ${v.b} 58%, ${fallback} 100%)`;
}

function patternOverlay(pattern: ProfileTheme["pattern"]): React.CSSProperties {
  if (pattern === "stars") {
    return {
      backgroundImage:
        "radial-gradient(circle at 18% 28%, rgba(255,255,255,.92) 0 1px, transparent 1.5px), radial-gradient(circle at 72% 22%, rgba(255,255,255,.72) 0 1.2px, transparent 1.8px), radial-gradient(circle at 82% 70%, rgba(255,255,255,.7) 0 1px, transparent 1.6px)",
    };
  }
  if (pattern === "hearts") {
    return { backgroundImage: "radial-gradient(circle at 20% 30%, rgba(255,255,255,.34) 0 6px, transparent 7px), radial-gradient(circle at 78% 64%, rgba(255,255,255,.25) 0 8px, transparent 9px)" };
  }
  if (pattern === "bubbles") {
    return { backgroundImage: "radial-gradient(circle at 14% 70%, rgba(255,255,255,.28) 0 14px, transparent 15px), radial-gradient(circle at 82% 18%, rgba(255,255,255,.24) 0 18px, transparent 19px), radial-gradient(circle at 58% 58%, rgba(255,255,255,.16) 0 10px, transparent 11px)" };
  }
  return {};
}

/** Presentational profile card body (banner + avatar + details + socials). The
 *  caller owns positioning/portal; links are inert in preview mode. */
export function ProfileCardView({ data, preview = false }: { data: ProfileCardData; preview?: boolean }) {
  const bannerColor = data.banner_color ?? "#5865f2";
  const theme = cleanTheme(data.profile_theme, bannerColor);
  const initial = (data.display_name || "?")[0]?.toUpperCase();
  const showStatus = data.profile_theme?.showStatus ?? true;
  const showBio = data.profile_theme?.showBio ?? true;
  const showActive = data.profile_theme?.showActive ?? true;
  const showSongs = data.profile_theme?.showSongs ?? true;
  const showSocials = data.profile_theme?.showSocials ?? true;
  const hasSocials = showSocials && SOCIAL_LINKS.some((s) => data[s.key]);
  const songs = showSongs ? (data.top_songs ?? []).filter((s) => s.title.trim()).slice(0, 3) : [];
  const bannerBg = gradientFor(theme, bannerColor);

  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        background: "linear-gradient(180deg, color-mix(in oklch, var(--bg-sidebar) 94%, white), var(--bg-sidebar))",
        boxShadow: theme.glow ? `inset 0 1px 0 rgba(255,255,255,.06), 0 0 36px color-mix(in oklch, ${theme.accent} 24%, transparent)` : undefined,
      }}
    >
      {/* Banner — image when set, otherwise a customizable gradient. */}
      <div style={{ position: "relative", height: 104, background: bannerBg, overflow: "hidden" }}>
        {data.banner_url && (
          <img
            src={data.banner_url}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        )}
        <div style={{ position: "absolute", inset: 0, ...patternOverlay(theme.pattern) }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 40%, rgba(0,0,0,.24))" }} />
        {theme.emoji && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: 14,
              bottom: 10,
              width: 38,
              height: 38,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,.24)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.22)",
              fontSize: 22,
              backdropFilter: "blur(10px)",
            }}
          >
            {theme.emoji}
          </div>
        )}
      </div>

      <div style={{ padding: "0 16px 16px" }}>
        {/* Avatar — overlaps banner */}
        <div style={{ marginTop: -34, marginBottom: 10, display: "flex", alignItems: "end", gap: 10 }}>
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: "50%",
              padding: 3,
              background: `linear-gradient(135deg, white, ${theme.accent})`,
              boxShadow: `0 8px 24px rgba(0,0,0,.24), 0 0 0 4px var(--bg-sidebar), 0 0 28px color-mix(in oklch, ${theme.accent} 38%, transparent)`,
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background: theme.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 25,
                fontWeight: 800,
                color: "#fff",
                overflow: "hidden",
              }}
            >
              {data.avatar_url ? (
                <img src={data.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                initial
              )}
            </div>
          </div>
          {showActive && (
            <div
              style={{
                marginBottom: 4,
                padding: "4px 8px",
                borderRadius: 999,
                background: "color-mix(in oklch, var(--bg-input) 82%, transparent)",
                color: "var(--text-muted)",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {data.last_active_at != null ? `Active ${relativeTime(data.last_active_at)}` : "Ohiyo friend"}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 18, color: "var(--text-primary)", lineHeight: 1.12 }}>
              {data.display_name || "Your name"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>@{data.username || "username"}</div>
          </div>

        </div>

        {showStatus && data.custom_status && (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              background: "linear-gradient(135deg, color-mix(in oklch, var(--bg-input) 88%, transparent), color-mix(in oklch, var(--bg-hover) 55%, transparent))",
              border: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)",
              borderRadius: 12,
              padding: "8px 10px",
              marginTop: 10,
              marginBottom: 10,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.04)",
            }}
          >
            <span style={{ marginRight: 6 }}>💬</span>{data.custom_status}
          </div>
        )}
        {showBio && data.bio && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              borderTop: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)",
              paddingTop: 10,
              marginTop: 8,
              marginBottom: 10,
              lineHeight: 1.55,
              maxHeight: 92,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {data.bio}
          </div>
        )}

        {songs.length > 0 && (
          <div style={{ borderTop: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)", paddingTop: 10, marginTop: 8 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                textTransform: "uppercase",
                color: "var(--text-muted)",
                marginBottom: 7,
                letterSpacing: "0.08em",
              }}
            >
              Top 3 songs
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {songs.map((song, i) => {
                const body = (
                  <>
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
                        borderRadius: 8,
                        display: "grid",
                        placeItems: "center",
                        background: `color-mix(in oklch, ${theme.accent} 18%, transparent)`,
                        color: theme.accent,
                        fontSize: 11,
                        fontWeight: 900,
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)", fontWeight: 750 }}>{song.title}</span>
                      {song.artist && <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 11 }}>{song.artist}</span>}
                    </span>
                    <span aria-hidden style={{ color: theme.accent }}>♪</span>
                  </>
                );
                const style: React.CSSProperties = {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                  padding: "7px 8px",
                  borderRadius: 12,
                  background: "linear-gradient(135deg, color-mix(in oklch, var(--bg-input) 88%, transparent), color-mix(in oklch, var(--bg-hover) 46%, transparent))",
                  border: `1px solid color-mix(in oklch, ${theme.accent} 12%, transparent)`,
                  textDecoration: "none",
                };
                const songHref = safeHttpUrl(song.url);
                return !preview && songHref ? (
                  <a key={`${song.title}-${i}`} href={songHref} target="_blank" rel="noopener noreferrer" style={style}>{body}</a>
                ) : (
                  <div key={`${song.title}-${i}`} style={style}>{body}</div>
                );
              })}
            </div>
          </div>
        )}

        {hasSocials && (
          <div style={{ borderTop: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)", paddingTop: 10, marginTop: 8 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                textTransform: "uppercase",
                color: "var(--text-muted)",
                marginBottom: 7,
                letterSpacing: "0.08em",
              }}
            >
              Connected
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {SOCIAL_LINKS.map((s) => {
                const val = data[s.key] as string | null | undefined;
                if (!val) return null;
                const row = (
                  <>
                    <span style={{ fontSize: 15 }}>{s.icon}</span>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                  </>
                );
                const style: React.CSSProperties = {
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  padding: "6px 8px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                  background: "var(--bg-input)",
                  border: "1px solid color-mix(in oklch, var(--text-primary) 7%, transparent)",
                };
                const socialHref = safeHttpUrl(s.buildUrl(val));
                return preview || !socialHref ? (
                  <div key={s.key} style={style} title={val}>{row}</div>
                ) : (
                  <a key={s.key} href={socialHref} target="_blank" rel="noopener noreferrer" style={style} title={val}>{row}</a>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
