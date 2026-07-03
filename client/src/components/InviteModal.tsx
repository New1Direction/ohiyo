import { useEffect, useRef, useState } from "react";
import { api, inviteUrl, type InviteInfo } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  serverName: string;
  serverIconUrl?: string | null;
  onClose: () => void;
  onInviteCreated?: () => void;
};

/** Generates a shareable invite link for a server and makes it one tap to copy. */
export function InviteModal({ token, serverId, serverName, serverIconUrl, onClose, onInviteCreated }: Props) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onInviteCreatedRef = useRef(onInviteCreated);
  onInviteCreatedRef.current = onInviteCreated;

  useEffect(() => {
    let alive = true;
    api
      .createInvite(token, serverId)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        onInviteCreatedRef.current?.();
      })
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
      <div className="kc-polish-hero flex flex-col items-center text-center">
        <div
          className="kc-polish-icon flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl text-3xl font-bold"
          aria-hidden
        >
          {serverIconUrl ? (
            <img src={serverIconUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            serverName.slice(0, 2).toUpperCase() || "✉️"
          )}
        </div>
        <h2
          id="kc-invite-title"
          className="kc-polish-title mt-2"
          style={{
            fontSize: "var(--text-2xl)",
          }}
        >
          Invite people
        </h2>
        <p className="kc-polish-copy mt-1 text-sm" style={{ maxWidth: 320 }}>
          Share this link and anyone can join <strong>{serverName}</strong>. It never expires.
        </p>
      </div>

      <div className="mt-6">
        {error ? (
          <div
            role="alert"
            className="kc-polish-surface px-3 py-2 text-xs"
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
          <div className="kc-polish-surface flex gap-2 p-2">
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
              className="kc-interactive kc-polish-button kc-polish-button--primary flex flex-shrink-0 items-center justify-center px-4 py-3 text-sm"
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
        className="kc-interactive kc-polish-button mt-5 w-full py-2.5 text-sm font-semibold"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        Done
      </button>
    </ModalShell>
  );
}
