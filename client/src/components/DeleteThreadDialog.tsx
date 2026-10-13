import { useState } from "react";
import { ModalShell } from "./ModalShell";
import type { ThreadSummary } from "../lib/threads";

/** Confirm deleting a thread: its replies go with it, for everyone. */
export function DeleteThreadDialog({
  thread,
  onDelete,
  onCancel,
}: {
  thread: ThreadSummary;
  onDelete: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replies = thread.message_count === 1 ? "Its 1 reply goes" : `Its ${thread.message_count} replies go`;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch {
      setError("Couldn't delete the thread. Try again?");
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onCancel} labelledBy="kc-delete-thread-title" maxWidthClass="max-w-md">
      <h2 id="kc-delete-thread-title" className="mb-2 text-xl font-bold" style={{ color: "var(--text-primary)" }}>
        Delete “{thread.name}”?
      </h2>
      <p className="mb-4 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        {thread.message_count > 0 ? `${replies} with it, for everyone.` : "Nobody has replied yet."} The message it
        started from stays in the channel.
      </p>
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
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="kc-interactive rounded px-4 py-2 text-sm font-semibold"
          style={{ background: "var(--danger-fill)", color: "#fff", border: "none", opacity: busy ? 0.65 : 1 }}
        >
          Delete thread
        </button>
      </div>
    </ModalShell>
  );
}
