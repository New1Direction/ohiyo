import { useEffect, useState } from "react";
import { api, type Channel, type PrivateDmLinkPreview, type PublicUser } from "../api";

function timeLeft(expiresAt: number): string {
  const left = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (left < 60) return `${left}s`;
  if (left < 3600) return `${Math.ceil(left / 60)}m`;
  if (left < 86400) return `${Math.ceil(left / 3600)}h`;
  return `${Math.ceil(left / 86400)}d`;
}

export function PrivateDmLinkAccept({
  token,
  linkToken,
  currentUserId,
  onAccepted,
  onDismiss,
}: {
  token: string;
  linkToken: string;
  currentUserId: string;
  onAccepted: (channel: Channel, creator: PublicUser) => void;
  onDismiss: () => void;
}) {
  const [preview, setPreview] = useState<PrivateDmLinkPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .previewPrivateDmLink(token, linkToken)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "This private DM link is invalid or expired.");
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [token, linkToken]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.redeemPrivateDmLink(token, linkToken);
      onAccepted(result.channel, result.creator);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not use that private DM link.");
      setBusy(false);
    }
  }

  const creator = preview?.creator;
  const isMine = creator?.id === currentUserId;

  return (
    <div className="flex min-h-screen items-center justify-center p-6" style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <div
        className="w-full max-w-md rounded-3xl p-6 text-center"
        style={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-hover)", boxShadow: "var(--shadow-xl)" }}
      >
        <div
          className="mx-auto grid h-16 w-16 place-items-center rounded-3xl text-3xl"
          style={{ background: "color-mix(in oklch, var(--accent) 16%, transparent)", color: "var(--accent)" }}
          aria-hidden
        >
          🕯️
        </div>
        <h1 className="mt-4" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-3xl)" }}>
          Private DM invitation
        </h1>

        {loading ? (
          <div className="mt-6 flex flex-col gap-2" aria-label="Checking private DM link">
            <div className="kc-skeleton" style={{ height: 54 }} />
            <div className="kc-skeleton" style={{ height: 44 }} />
          </div>
        ) : error ? (
          <div className="mt-5 rounded-2xl p-4 text-sm leading-6" role="alert" style={{ background: "color-mix(in oklch, var(--danger) 12%, transparent)", color: "var(--danger)" }}>
            {error}
          </div>
        ) : creator ? (
          <>
            <div className="mt-5 flex items-center gap-3 rounded-2xl p-3 text-left" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
              <div
                className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full text-base font-bold"
                style={{
                  background: "var(--accent)",
                  color: "#fff",
                  backgroundImage: creator.avatar_url ? `url(${creator.avatar_url})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {!creator.avatar_url && (creator.display_name[0] ?? creator.username[0] ?? "?").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold" style={{ color: "var(--text-primary)" }}>{creator.display_name}</div>
                <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>@{creator.username}</div>
              </div>
            </div>

            <p className="mt-4 text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
              This link opens a one-to-one encrypted conversation. It expires in <strong>{timeLeft(preview!.expires_at)}</strong> and
              burns after the first successful use.
            </p>

            {isMine ? (
              <div className="mt-4 rounded-2xl p-3 text-sm" style={{ background: "var(--bg-sidebar)", color: "var(--text-muted)" }}>
                You created this link. Send it to someone else — your own account cannot redeem it.
              </div>
            ) : (
              <button
                type="button"
                onClick={accept}
                disabled={busy}
                className="kc-cta mt-5 w-full rounded-full px-5 py-3 text-sm"
              >
                {busy ? "Opening…" : `Open DM with ${creator.display_name}`}
              </button>
            )}
          </>
        ) : null}

        <button
          type="button"
          onClick={onDismiss}
          className="kc-interactive mt-4 w-full rounded-full px-4 py-2.5 text-sm font-semibold"
          style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}
        >
          Back to Ohiyo
        </button>
      </div>
    </div>
  );
}
