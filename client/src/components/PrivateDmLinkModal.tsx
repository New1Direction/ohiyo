import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, privateDmUrl, type PrivateDmLinkInfo, type PublicUser } from "../api";
import { ModalShell } from "./ModalShell";

const EXPIRY_OPTIONS = [
  { label: "1 hour", seconds: 60 * 60, hint: "Best for an in-person QR scan." },
  { label: "24 hours", seconds: 60 * 60 * 24, hint: "Good default for sending once." },
  { label: "7 days", seconds: 60 * 60 * 24 * 7, hint: "Use only when someone may be offline." },
] as const;

function expiresLabel(expiresAt: number): string {
  const left = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (left < 90) return `${left}s`;
  if (left < 3600) return `${Math.ceil(left / 60)}m`;
  if (left < 86400) return `${Math.ceil(left / 3600)}h`;
  return `${Math.ceil(left / 86400)}d`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PrivateDmLinkModal({
  token,
  currentUser,
  onClose,
  onToast,
}: {
  token: string;
  currentUser: PublicUser;
  onClose: () => void;
  onToast: (message: string, type?: "info" | "success" | "error") => void;
}) {
  const [expiry, setExpiry] = useState<number>(60 * 60 * 24);
  const [info, setInfo] = useState<PrivateDmLinkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const url = info ? privateDmUrl(info.token) : "";

  async function create() {
    setBusy(true);
    setError(null);
    setCopied(false);
    setRevoked(false);
    try {
      setInfo(await api.createPrivateDmLink(token, expiry));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create a private DM link.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    const ok = await copyText(url);
    if (!ok) {
      onToast("Clipboard is blocked — select the link field and copy manually.", "info");
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  async function revoke() {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await api.revokePrivateDmLink(token, info.token);
      setRevoked(true);
      onToast("Private DM link revoked", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke that link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-private-dm-link-title" maxWidthClass="max-w-md">
      <div className="flex flex-col items-center text-center">
        <div
          className="grid h-16 w-16 place-items-center rounded-3xl text-3xl"
          style={{ background: "color-mix(in oklch, var(--accent) 16%, transparent)", color: "var(--accent)", boxShadow: "var(--shadow-md)" }}
          aria-hidden
        >
          🕯️
        </div>
        <h2
          id="kc-private-dm-link-title"
          className="mt-3"
          style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
        >
          One-time private DM link
        </h2>
        <p className="mt-1 text-sm leading-6" style={{ color: "var(--text-secondary)", maxWidth: 360 }}>
          Let one person open an end-to-end encrypted DM with <strong>{currentUser.display_name}</strong> without making
          your profile searchable first. The link expires and burns after the first successful use.
        </p>
      </div>

      <div className="mt-5 rounded-2xl p-3" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.05em" }}>
          Expiration
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {EXPIRY_OPTIONS.map((opt) => {
            const selected = expiry === opt.seconds;
            return (
              <button
                key={opt.seconds}
                type="button"
                disabled={busy || Boolean(info && !revoked)}
                onClick={() => setExpiry(opt.seconds)}
                className="kc-interactive rounded-xl px-3 py-2 text-left"
                style={{
                  border: selected ? "1px solid var(--accent)" : "1px solid var(--bg-hover)",
                  background: selected ? "color-mix(in oklch, var(--accent) 12%, transparent)" : "var(--bg-input)",
                  color: "var(--text-primary)",
                  opacity: busy || (info && !revoked) ? 0.7 : 1,
                }}
              >
                <span className="block text-sm font-bold">{opt.label}</span>
                <span className="block text-[11px] leading-4" style={{ color: "var(--text-muted)" }}>{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-xl px-3 py-2 text-sm"
          style={{ background: "color-mix(in oklch, var(--danger) 12%, transparent)", color: "var(--danger)" }}
        >
          {error}
        </div>
      )}

      {!info || revoked ? (
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="kc-cta mt-5 w-full rounded-full px-4 py-3 text-sm"
        >
          {busy ? "Creating…" : revoked ? "Create a fresh link" : "Create one-time link + QR"}
        </button>
      ) : (
        <div className="mt-5">
          <div className="flex flex-col items-center rounded-3xl p-4" style={{ background: "#fff", color: "#111" }}>
            <QRCodeSVG value={url} size={184} marginSize={1} />
            <div className="mt-2 text-xs font-semibold text-neutral-600">Scan once to start a private DM</div>
          </div>

          <div className="mt-3 flex gap-2">
            <input
              readOnly
              value={url}
              aria-label="One-time private DM link"
              onFocus={(e) => e.currentTarget.select()}
              className="kc-field min-w-0 flex-1 px-3 py-3 text-xs outline-none"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
            <button type="button" onClick={copy} className="kc-cta flex-shrink-0 px-4 py-3 text-sm" style={{ minWidth: 92 }}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>

          <div className="mt-3 rounded-xl p-3 text-xs leading-5" style={{ background: "var(--bg-sidebar)", color: "var(--text-secondary)", border: "1px solid var(--bg-hover)" }}>
            <strong style={{ color: "var(--text-primary)" }}>Security:</strong> the server stores only a hash of this bearer token.
            It expires in <strong>{expiresLabel(info.expires_at)}</strong>, can be used once, and should be revoked if you shared it in the wrong place.
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={revoke}
            className="kc-interactive mt-3 w-full rounded-full px-4 py-2.5 text-sm font-semibold"
            style={{ background: "var(--bg-input)", color: "var(--danger)", border: "none" }}
          >
            {busy ? "Revoking…" : "Revoke this link"}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="kc-interactive mt-3 w-full py-2.5 text-sm font-semibold"
        style={{ borderRadius: "var(--radius-md)", background: "transparent", color: "var(--text-secondary)" }}
      >
        Back to Ohiyo
      </button>
    </ModalShell>
  );
}
