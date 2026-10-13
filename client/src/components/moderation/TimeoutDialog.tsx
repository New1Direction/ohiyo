import { useId, useState } from "react";
import { ModalShell } from "../ModalShell";
import { TIMEOUT_CHOICES } from "../../lib/moderation";
import { errorText } from "./errorText";
import "./moderation.css";

const DEFAULT_SECONDS = 10 * 60;

/** Time one member out: how long (as Discord offers it) and, if you like, why. */
export function TimeoutDialog({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: (seconds: number, reason: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const group = useId();

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(seconds, reason.trim());
    } catch (err) {
      setError(errorText(err, `Couldn't time ${name} out. Try again?`));
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId}>
      <h2 id={titleId} className="kc-mod-title">
        Time out {name}
      </h2>
      <p className="kc-mod-lede">
        They can still read, but can&apos;t post, react, start threads, make invites or join voice until it ends.
      </p>
      <fieldset className="kc-mod-fieldset">
        <legend className="kc-mod-legend">How long</legend>
        <div className="kc-mod-choices">
          {TIMEOUT_CHOICES.map((choice) => (
            <label key={choice.seconds} className="kc-mod-choice">
              <input
                type="radio"
                name={group}
                value={choice.seconds}
                checked={seconds === choice.seconds}
                onChange={() => setSeconds(choice.seconds)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="kc-mod-field">
        <span>Reason (optional)</span>
        <textarea
          aria-label="Reason (optional)"
          className="kc-field px-3 py-2 text-sm"
          maxLength={512}
          value={reason}
          placeholder="Only moderators see this, in the moderation log."
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
          Time out
        </button>
      </div>
    </ModalShell>
  );
}
