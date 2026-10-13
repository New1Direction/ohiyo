import { useId, useState } from "react";
import { ModalShell } from "../ModalShell";
import { BAN_DELETE_CHOICES } from "../../lib/moderation";
import { errorText } from "./errorText";
import "./moderation.css";

/** Ban one member: why, and whether to take their recent messages with them. */
export function BanDialog({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: (choice: { reason: string; deleteMessageSeconds: number }) => void | Promise<void>;
  onClose: () => void;
}) {
  const [deleteMessageSeconds, setDeleteMessageSeconds] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ reason: reason.trim(), deleteMessageSeconds });
    } catch (err) {
      setError(errorText(err, `Couldn't ban ${name}. Try again?`));
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId}>
      <h2 id={titleId} className="kc-mod-title">
        Ban {name}?
      </h2>
      <p className="kc-mod-lede">
        They&apos;re removed from the space and can&apos;t come back, even with an invite, until someone lifts the ban.
      </p>
      <label className="kc-mod-field">
        <span>Delete their messages</span>
        <select
          aria-label="Delete their messages"
          className="kc-field px-3 py-2 text-sm"
          value={String(deleteMessageSeconds)}
          onChange={(e) => setDeleteMessageSeconds(Number(e.target.value))}
        >
          {BAN_DELETE_CHOICES.map((choice) => (
            <option key={choice.seconds} value={String(choice.seconds)}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <label className="kc-mod-field">
        <span>Reason (optional)</span>
        <input
          aria-label="Reason (optional)"
          className="kc-field px-3 py-2 text-sm"
          maxLength={512}
          value={reason}
          placeholder="Shown in the ban list and the moderation log."
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="kc-mod-error">
          {error}
        </p>
      )}
      <div className="kc-mod-actions">
        <button type="button" onClick={onClose} className="kc-interactive kc-polish-button kc-mod-button">
          Cancel
        </button>
        <button type="button" onClick={() => void confirm()} disabled={busy} className="kc-interactive kc-mod-button kc-mod-button--danger">
          Ban
        </button>
      </div>
    </ModalShell>
  );
}
