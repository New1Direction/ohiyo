import { useState } from "react";
import type { NewDevice } from "../lib/deviceWatch";

type Props = {
  devices: NewDevice[];
  busy: boolean;
  /** "It was me": keep the devices. */
  onKeep: () => void;
  /** "Not me": take the devices off the account and sign out every session. */
  onRemove: () => void;
  /** Sits under the desktop update bar when that is showing. */
  lowered?: boolean;
};

function ago(seenAt: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - seenAt);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/** A device was added to your account since this one last looked. Asks whether it was
 *  you; "Not me" asks once more, because it signs this device out too. */
export function NewDeviceAlert({ devices, busy, onKeep, onRemove, lowered }: Props) {
  const [confirming, setConfirming] = useState(false);
  if (devices.length === 0) return null;
  const one = devices.length === 1;
  const latest = Math.max(...devices.map((d) => d.seen_at));
  return (
    <div className={`kc-device-alert${lowered ? " kc-device-alert--lowered" : ""}`} role="alert" aria-live="assertive">
      <div className="kc-device-alert__title">
        {one ? "A new device signed in to your account" : `${devices.length} new devices signed in to your account`}
        <span className="kc-device-alert__when"> · {ago(latest)}</span>
      </div>
      {confirming ? (
        <>
          <p className="kc-device-alert__text">
            Ohiyo will take {one ? "it" : "them"} off your account and sign you out everywhere, on this device too. Sign
            back in after.
          </p>
          <div className="kc-device-alert__actions">
            <button type="button" className="kc-device-alert__danger" disabled={busy} onClick={onRemove}>
              {busy ? "Removing…" : "Remove and sign out"}
            </button>
            <button type="button" className="kc-device-alert__plain" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="kc-device-alert__text">
            {one ? "It" : "They"} can read encrypted messages sent to you from now on. If this wasn&apos;t you, remove{" "}
            {one ? "it" : "them"}.
          </p>
          <div className="kc-device-alert__actions">
            <button type="button" className="kc-device-alert__plain" onClick={onKeep}>
              It was me
            </button>
            <button type="button" className="kc-device-alert__danger" onClick={() => setConfirming(true)}>
              Not me
            </button>
          </div>
        </>
      )}
    </div>
  );
}
