import { useId, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { ModalShell } from "./ModalShell";
import "./roles.css";

const SPACE_NAME_MAX = 100;

type Props = {
  name: string;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
};

/** Give the space a new name; everyone in it sees the change straight away. */
export function RenameSpaceDialog({ name, onRename, onClose }: Props) {
  const titleId = useId();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = value.trim();
  const unchanged = trimmed === name;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !trimmed || unchanged) return;
    setBusy(true);
    setError("");
    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't rename the space. Try again?"));
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <h2 id={titleId} className="kc-role-editor__title">
          Rename space
        </h2>
        <label className="kc-role-editor__field">
          <span className="kc-role-editor__legend">Space name</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Space name"
            maxLength={SPACE_NAME_MAX}
            className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="kc-role-editor__note is-error">
            {error}
          </p>
        )}
        <div className="kc-role-editor__actions">
          <button type="button" onClick={onClose} className="kc-notif-cancel">
            Cancel
          </button>
          <button type="submit" disabled={busy || !trimmed || unchanged} className="kc-cta px-4 py-2 text-sm">
            {busy ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
