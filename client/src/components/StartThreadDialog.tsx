import { useState } from "react";
import { ModalShell } from "./ModalShell";

const MAX_NAME = 100;

/** Name a new thread before starting it; the name starts as the message's first line. */
export function StartThreadDialog({
  suggestedName,
  onStart,
  onCancel,
}: {
  suggestedName: string;
  onStart: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(name.trim());
    } catch {
      setError("Couldn't start the thread. Try again?");
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onCancel} labelledBy="kc-start-thread-title" maxWidthClass="max-w-md">
      <form onSubmit={submit}>
        <h2 id="kc-start-thread-title" className="mb-2 text-xl font-bold" style={{ color: "var(--text-primary)" }}>
          Start a thread
        </h2>
        <p className="mb-4 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
          Replies go in the thread, so the channel stays easy to follow.
        </p>
        <input
          className="kc-field mb-2 w-full px-3.5 py-2.5 text-sm outline-none"
          aria-label="Thread name"
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
          placeholder="Thread name"
        />
        {error && (
          <p role="alert" className="mb-2 text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="kc-interactive rounded px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}
          >
            Cancel
          </button>
          <button type="submit" disabled={busy} className="kc-cta px-4 py-2 text-sm" style={{ opacity: busy ? 0.65 : 1 }}>
            Start thread
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
