import { useId, useState } from "react";
import { ModalShell } from "../ModalShell";
import { SLOWMODE_CHOICES } from "../../lib/moderation";
import { errorText } from "./errorText";
import "./moderation.css";

/** Set how long each person waits between messages in one channel. */
export function SlowmodeDialog({
  channelName,
  seconds,
  onSave,
  onClose,
}: {
  channelName: string;
  seconds: number;
  onSave: (seconds: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(choice);
    } catch (err) {
      setError(errorText(err, "Couldn't change slowmode. Try again?"));
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId}>
      <h2 id={titleId} className="kc-mod-title">
        Slowmode in #{channelName}
      </h2>
      <p className="kc-mod-lede">
        Each person waits this long between messages here. People who manage messages or channels aren&apos;t slowed down.
      </p>
      <label className="kc-mod-field">
        <span>Time between messages</span>
        <select
          aria-label="Slowmode"
          className="kc-field px-3 py-2 text-sm"
          value={String(choice)}
          onChange={(e) => setChoice(Number(e.target.value))}
        >
          {SLOWMODE_CHOICES.map((c) => (
            <option key={c.seconds} value={String(c.seconds)}>
              {c.label}
            </option>
          ))}
        </select>
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
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="kc-interactive kc-polish-button kc-polish-button--primary kc-mod-button"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}
