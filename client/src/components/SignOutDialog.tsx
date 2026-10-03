import { ModalShell } from "./ModalShell";

type Props = {
  onCancel: () => void;
  onConfirm: () => void;
};

/** Asked before signing out of the last signed-in home on this device, which removes the
 *  decrypted-message cache, the outbox and drafts (see lib/signOut.ts). */
export function SignOutDialog({ onCancel, onConfirm }: Props) {
  return (
    <ModalShell onClose={onCancel} labelledBy="kc-sign-out-title" maxWidthClass="max-w-md">
      <h2 id="kc-sign-out-title" className="mb-2 text-xl font-bold" style={{ color: "var(--text-primary)" }}>
        Sign out?
      </h2>
      <p className="mb-5 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        Encrypted messages you have read on this device, unsent messages and drafts will be removed from it. Those encrypted messages
        can&apos;t be decrypted here again. Your other devices are not affected.
      </p>
      <div className="flex justify-end gap-2">
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
          onClick={onConfirm}
          className="kc-interactive rounded px-4 py-2 text-sm font-semibold"
          style={{ background: "var(--danger)", color: "#fff", border: "none" }}
        >
          Sign out
        </button>
      </div>
    </ModalShell>
  );
}
