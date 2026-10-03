import { useState } from "react";
import type { VaultLocked } from "../lib/vaultLock";
import { errorMessage } from "../lib/errorMessage";

type Props = {
  locked: VaultLocked;
  /** Restart the app. */
  onTryAgain: () => Promise<void>;
  /** Reset this device's vault, then restart. Only offered when the saved keys can't be opened. */
  onReset: () => Promise<void>;
};

const ADVICE: Record<VaultLocked["kind"], string> = {
  keychain:
    "Ohiyo keeps your encryption keys in the system keychain. Unlock it (on Linux, start a Secret Service provider such as GNOME Keyring or KWallet), then try again. Nothing was deleted.",
  vault: "The encryption keys saved on this device can't be opened.",
};

/** Desktop only: shown instead of the app when the key vault couldn't be unlocked, so the
 *  app never starts with an empty vault that would replace the saved keys. */
export function VaultLockedScreen({ locked, onTryAgain, onReset }: Props) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action(); // on success the app restarts
    } catch (err) {
      setError(errorMessage(err, "That didn't work. Try again."));
      setBusy(false);
    }
  }

  return (
    <div role="alert" className="fixed inset-0 grid place-items-center p-6 text-center text-sm">
      <div className="max-w-md">
        <p className="mb-2 font-semibold">Ohiyo couldn&apos;t unlock your encrypted key vault.</p>
        <p className="mb-2 opacity-80">{ADVICE[locked.kind]}</p>
        <p className="mb-4 text-xs opacity-60">{locked.reason}</p>
        {error && <p className="mb-4" style={{ color: "var(--danger)" }}>{error}</p>}
        {confirmingReset ? (
          <ResetDeviceConfirm busy={busy} onConfirm={() => void run(onReset)} onCancel={() => setConfirmingReset(false)} />
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className="kc-cta rounded px-4 py-2 font-semibold" disabled={busy} onClick={() => void run(onTryAgain)}>
              Try again
            </button>
            {locked.kind === "vault" && (
              <button
                type="button"
                className="rounded px-4 py-2"
                style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)" }}
                disabled={busy}
                onClick={() => setConfirmingReset(true)}
              >
                Reset this device
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What a reset costs, said before anything happens. */
export function ResetDeviceConfirm({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="rounded-lg p-4 text-left" style={{ border: "1px solid var(--danger)" }}>
      <p className="mb-2 font-semibold">Reset this device?</p>
      <ul className="mb-4 list-disc pl-5 opacity-80">
        <li>Encrypted messages stored on this device can no longer be read here.</li>
        <li>You&apos;ll be signed out.</li>
        <li>Your contacts will see a new safety number for you.</li>
        <li>
          This device will count as a new one of your 10 linked devices. You can remove the old one in Settings → Privacy &amp; security →
          Linked devices.
        </li>
      </ul>
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded px-3 py-1.5" style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="rounded px-3 py-1.5 font-semibold" style={{ background: "var(--danger)", color: "#fff" }} disabled={busy} onClick={onConfirm}>
          Reset this device
        </button>
      </div>
    </div>
  );
}
