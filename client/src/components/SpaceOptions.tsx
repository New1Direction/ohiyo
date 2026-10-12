import { useLayoutEffect, useRef, useState } from "react";
import { deleteSpaceMessage } from "../lib/apiErrors";
import { ConfirmWithPassword } from "./settings/ConfirmWithPassword";

type Props = {
  name: string;
  /** The owner deletes the space; anyone else leaves it. */
  isOwner: boolean;
  onLeave: () => Promise<void>;
  onDelete: (password: string) => Promise<void>;
  onClose: () => void;
};

/** Opened from Space options in the space's header. A member leaves with one more press; the
 *  owner, who can't leave, deletes the space for everyone with their password. */
export function SpaceOptions({ name, isOwner, onLeave, onDelete, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = useRef<HTMLParagraphElement>(null);

  // A member lands on the question; the owner's password field takes focus itself.
  useLayoutEffect(() => {
    if (!isOwner) question.current?.focus();
  }, [isOwner]);

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await onLeave();
    } catch {
      setError("Couldn't leave. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function remove(password: string) {
    setBusy(true);
    setError(null);
    try {
      await onDelete(password);
    } catch (err) {
      setError(deleteSpaceMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="kc-space-options mt-2 rounded-md p-3 text-xs" style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}>
      {isOwner ? (
        <>
          <p ref={question} tabIndex={-1}>
            Delete <strong style={{ color: "var(--text-primary)" }}>{name}</strong> for everyone? Every channel, message and
            file in it goes at once, and it can&apos;t be undone. Enter your password to delete it.
          </p>
          <ConfirmWithPassword confirmLabel="Delete space" busy={busy} onConfirm={remove} onCancel={onClose} />
        </>
      ) : (
        <>
          <p ref={question} tabIndex={-1}>
            Leave <strong style={{ color: "var(--text-primary)" }}>{name}</strong>? You&apos;ll need a new invite to come back.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void leave()}
              className="rounded px-3 py-1.5 text-sm font-semibold"
              style={{ background: "var(--danger-fill)", color: "#fff", opacity: busy ? 0.6 : 1 }}
            >
              {busy ? "Leaving…" : "Leave space"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="kc-interactive rounded px-3 py-1.5 text-sm"
              style={{ color: "var(--text-secondary)", background: "var(--bg-hover)" }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-1" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
