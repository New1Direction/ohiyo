import { useState } from "react";
import { useConfirmFocus } from "../hooks/useConfirmFocus";
import { deviceAlertAgo, type NewDevice } from "../lib/deviceWatch";

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

/** A device was added to your account since this one last looked. Asks whether it was
 *  you; "Not me" asks once more, because it signs this device out too. The parent keys it
 *  by the devices shown, so a new set starts at the first question again. */
export function NewDeviceAlert({ devices, busy, onKeep, onRemove, lowered }: Props) {
  const [confirming, setConfirming] = useState(false);
  const focus = useConfirmFocus<HTMLParagraphElement, HTMLButtonElement>(confirming);
  if (devices.length === 0) return null;
  const one = devices.length === 1;
  const latest = Math.max(...devices.map((d) => d.seen_at));
  return (
    <div className={`kc-device-alert${lowered ? " kc-device-alert--lowered" : ""}`} role="alert" aria-live="assertive">
      <div className="kc-device-alert__title">
        {one ? "A new device signed in to your account" : `${devices.length} new devices signed in to your account`}
        <span className="kc-device-alert__when"> · {deviceAlertAgo(latest)}</span>
      </div>
      {confirming ? (
        <>
          <p ref={focus.question} tabIndex={-1} className="kc-device-alert__text">
            Ohiyo will take {one ? "it" : "them"} off your account and sign you out everywhere, on this device too. Sign
            back in after. If someone may know your password, change it in Settings → Account.
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
            <button
              ref={focus.opener}
              type="button"
              className="kc-device-alert__danger"
              onClick={() => setConfirming(true)}
            >
              Not me
            </button>
          </div>
        </>
      )}
    </div>
  );
}
