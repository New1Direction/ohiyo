import { useEffect, useRef, useState } from "react";
import { api, inviteUrl, type InviteInfo } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  serverName: string;
  onClose: () => void;
};

/** Generates a shareable invite link for a server and makes it one tap to copy. */
export function InviteModal({ token, serverId, serverName, onClose }: Props) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .createInvite(token, serverId)
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Couldn't create an invite link."));
    return () => {
      alive = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [token, serverId]);

  const url = info ? inviteUrl(info.code) : "";

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (insecure context) — the field is selectable as a fallback.
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-invite-title">
      <div className="flex flex-col items-center text-center">
        <div className="text-3xl" aria-hidden>
          ✉️
        </div>
        <h2
          id="kc-invite-title"
          className="mt-2"
          style={{
            fontFamily: "var(--font-display)", fontWeight: 700,
            fontSize: "var(--text-2xl)", color: "var(--text-primary)",
          }}
        >
          Invite people
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)", maxWidth: 320 }}>
          Share this link and anyone can join <strong>{serverName}</strong>. It never expires.
        </p>
      </div>

      <div className="mt-6">
        {error ? (
          <div
            role="alert"
            className="px-3 py-2 text-xs"
            style={{
              background: "color-mix(in oklch, var(--danger) 12%, transparent)",
              color: "var(--danger)", borderRadius: "var(--radius-md)", fontWeight: 500,
            }}
          >
            {error}
          </div>
        ) : !info ? (
          <div className="kc-skeleton" style={{ height: 46 }} />
        ) : (
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className="kc-field flex-1 px-3 py-3 text-sm outline-none"
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
            <button
              type="button"
              onClick={copy}
              className="kc-cta flex flex-shrink-0 items-center justify-center px-4 py-3 text-sm"
              style={{ minWidth: 92 }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="kc-interactive mt-5 w-full py-2.5 text-sm font-semibold"
        style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }}
      >
        Done
      </button>
    </ModalShell>
  );
}
