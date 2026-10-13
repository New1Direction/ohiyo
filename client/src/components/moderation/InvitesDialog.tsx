import { useEffect, useId, useState } from "react";
import { ModalShell } from "../ModalShell";
import type { InviteRow, InviteSettings } from "../../api";
import { inviteSummary } from "../../lib/moderation";
import { errorText } from "./errorText";
import "./moderation.css";

export type { InviteRow, InviteSettings };

type Api = {
  list: () => Promise<InviteRow[]>;
  revoke: (code: string) => Promise<void>;
  getSettings: () => Promise<InviteSettings | null>;
  updateSettings: (patch: Partial<InviteSettings>) => Promise<InviteSettings>;
};

function Setting({
  label,
  hint,
  on,
  busy,
  tone,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  busy: boolean;
  tone?: "warning";
  onToggle: () => void;
}) {
  return (
    <div className="kc-mod-setting" data-on={on} data-tone={tone}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {label}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {hint}
        </div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={onToggle} className="kc-switch">
        <span className="kc-switch__knob" />
      </button>
    </div>
  );
}

/** A space's invite links, with who made each, how long it lasts and its uses left. People
 *  who manage the space see every link and can pause invites or stop members making them;
 *  everyone else sees (and can revoke) their own. */
export function InvitesDialog({
  api,
  canManageServer,
  now,
  onClose,
}: {
  api: Api;
  canManageServer: boolean;
  /** The time to measure expiry from (tests pin it); now, otherwise. */
  now?: number;
  onClose: () => void;
}) {
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [settings, setSettings] = useState<InviteSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const at = now ?? Date.now();

  useEffect(() => {
    let alive = true;
    api
      .list()
      .then((rows) => alive && setInvites(rows))
      .catch((err) => alive && setError(errorText(err, "Couldn't load the invite links.")));
    if (canManageServer) {
      api
        .getSettings()
        .then((s) => alive && setSettings(s))
        .catch((err) => alive && setError(errorText(err, "Couldn't load the invite settings.")));
    }
    return () => {
      alive = false;
    };
    // Loads once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function update(patch: Partial<InviteSettings>) {
    if (busy) return;
    setBusy("settings");
    setError(null);
    try {
      setSettings(await api.updateSettings(patch));
    } catch (err) {
      setError(errorText(err, "Couldn't change that. Try again?"));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(code: string) {
    if (busy) return;
    setBusy(code);
    setError(null);
    try {
      await api.revoke(code);
      setInvites((rows) => (rows ?? []).filter((row) => row.code !== code));
    } catch (err) {
      setError(errorText(err, "Couldn't revoke that link."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-lg">
      <h2 id={titleId} className="kc-mod-title">
        Invites
      </h2>
      <p className="kc-mod-lede">
        {canManageServer
          ? "Every invite link to this space. Revoking one stops it working at once; people who joined with it stay."
          : "The invite links you made. Revoking one stops it working at once; people who joined with it stay."}
      </p>

      {canManageServer && settings && (
        <div className="kc-mod-section">
          <Setting
            label="Pause invites"
            hint={
              settings.paused
                ? "Paused: links turn newcomers away until you resume. People already here aren't affected."
                : "Stop every link letting new people in, for now. Handy during a raid."
            }
            on={settings.paused}
            tone="warning"
            busy={busy === "settings"}
            onToggle={() => void update({ paused: !settings.paused })}
          />
          <Setting
            label="Members can create invites"
            hint={
              settings.members_can_invite
                ? "Anyone in the space can make links."
                : "Only people who manage the space can make links."
            }
            on={settings.members_can_invite}
            busy={busy === "settings"}
            onToggle={() => void update({ members_can_invite: !settings.members_can_invite })}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="kc-mod-error">
          {error}
        </p>
      )}

      {invites === null ? (
        !error && <div className="kc-skeleton mt-4" style={{ height: 64 }} aria-hidden="true" />
      ) : invites.length === 0 ? (
        <p className="kc-mod-empty">No invite links yet.</p>
      ) : (
        <ul className="kc-mod-list" aria-label="Invite links">
          {invites.map((invite) => {
            const summary = inviteSummary(invite, at);
            const dead = summary === "Expired" || summary === "Used up";
            return (
              <li key={invite.code} className="kc-mod-row" data-faded={dead}>
                <div className="kc-mod-row__body">
                  <div className="kc-mod-row__code">{invite.code}</div>
                  <div className="kc-mod-row__meta">
                    By {invite.created_by_name ?? "a deleted account"} · used {invite.uses} {invite.uses === 1 ? "time" : "times"}
                  </div>
                  <div className="kc-mod-row__meta" style={{ color: dead ? "var(--danger)" : undefined }}>
                    {summary}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Revoke invite ${invite.code}`}
                  disabled={busy === invite.code}
                  onClick={() => void revoke(invite.code)}
                  className="kc-interactive kc-polish-button kc-polish-button--danger kc-mod-button kc-mod-button--small"
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="kc-mod-actions">
        <button type="button" onClick={onClose} className="kc-interactive kc-polish-button kc-mod-button">
          Done
        </button>
      </div>
    </ModalShell>
  );
}
