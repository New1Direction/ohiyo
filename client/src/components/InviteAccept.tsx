import { useEffect, useState } from "react";
import { api, type InvitePreview, type ServerWithChannels } from "../api";
import { BirdMark } from "./BirdMark";

type Props = {
  token: string;
  code: string;
  /** Joined (or opened) a server — enter it. */
  onJoin: (server: ServerWithChannels) => void;
  /** Dismiss the invite and go to the normal app. */
  onDismiss: () => void;
};

/** Full-screen accept card shown when the URL carries ?invite=CODE. */
export function InviteAccept({ token, code, onJoin, onDismiss }: Props) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getInvite(token, code)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "This invite link is invalid or has expired."));
    return () => {
      alive = false;
    };
  }, [token, code]);

  async function join() {
    setJoining(true);
    setError("");
    try {
      const server = await api.redeemInvite(token, code);
      setJoining(false);
      onJoin(server);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join — try again.");
      setJoining(false);
    }
  }

  const initials = preview
    ? preview.server_name.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").slice(0, 2).join("")
    : "";

  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{
        background:
          "radial-gradient(circle at 30% 20%, color-mix(in oklch, var(--accent) 16%, var(--bg-base)) 0%, var(--bg-base) 55%)",
        padding: "var(--space-4)",
      }}
    >
      <div
        className="kc-fade-up w-full max-w-sm text-center"
        style={{
          background: "var(--bg-channel)",
          borderRadius: "var(--radius-xl)",
          padding: "var(--space-8)",
          boxShadow: "var(--shadow-lg)",
          border: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)",
        }}
      >
        {!preview && !error ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="kc-loader" style={{ color: "var(--accent)" }}>
              <BirdMark size={44} />
            </div>
            <div className="text-sm" style={{ color: "var(--text-muted)" }}>
              Checking your invite…
            </div>
          </div>
        ) : error ? (
          <>
            <div className="text-3xl" aria-hidden>🚫</div>
            <h1 className="mt-3" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-xl)", color: "var(--text-primary)" }}>
              Invite not available
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{error}</p>
            <button
              type="button"
              onClick={onDismiss}
              className="kc-cta mt-6 w-full py-3 text-sm"
            >
              Go to Kikkacord
            </button>
          </>
        ) : preview ? (
          <>
            <div className="mb-1 text-xs font-semibold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
              You're invited to
            </div>
            <div
              className="mx-auto mb-3 mt-2 flex items-center justify-center"
              style={{
                width: 76, height: 76, borderRadius: "var(--radius-lg)",
                background: "var(--accent)", color: "#fff",
                fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)",
                backgroundImage: preview.icon_url ? `url(${preview.icon_url})` : undefined,
                backgroundSize: "cover", backgroundPosition: "center",
              }}
            >
              {!preview.icon_url && (initials || "?")}
            </div>
            <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}>
              {preview.server_name}
            </h1>
            <div className="mt-1 flex items-center justify-center gap-1.5 text-sm" style={{ color: "var(--text-secondary)" }}>
              <span className="kc-pulse" style={{ width: 7, height: 7, background: "var(--green)" }} />
              {preview.member_count} {preview.member_count === 1 ? "member" : "members"}
            </div>

            <button
              type="button"
              onClick={join}
              disabled={joining}
              aria-label={joining ? "Joining…" : undefined}
              className="kc-cta mt-6 flex w-full items-center justify-center gap-2 py-3 text-sm"
              style={{ opacity: joining ? 0.7 : 1 }}
            >
              {joining ? (
                <span className="kc-spinner" style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }} />
              ) : preview.already_member ? (
                "Open server"
              ) : (
                "Accept invite & join"
              )}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="kc-interactive mt-3 text-sm font-semibold"
              style={{ color: "var(--text-muted)", background: "none", border: "none" }}
            >
              Maybe later
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
