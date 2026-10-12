import { useId, useLayoutEffect, useRef, useState } from "react";
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

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A device was added to your account since this one last looked. Asks whether it was
 *  you; "Not me" asks once more, because it signs this device out too. The parent keys it
 *  by the devices shown, so a new set starts at the first question again.
 *
 *  It is a modal alertdialog over everything, Settings included: it takes focus when it
 *  appears (the box itself, so Enter can't answer it by accident), keeps Tab inside, and
 *  gives focus back to where it was when it goes. */
export function NewDeviceAlert({ devices, busy, onKeep, onRemove, lowered }: Props) {
  const [confirming, setConfirming] = useState(false);
  const focus = useConfirmFocus<HTMLParagraphElement, HTMLButtonElement>(confirming);
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const textId = useId();
  const shown = devices.length > 0;

  useLayoutEffect(() => {
    if (!shown) return;
    const returnTo = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => {
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [shown]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // A security question needs an answer: Escape neither dismisses it nor reaches a
    // dialog underneath (Settings closes on Escape).
    if (e.key === "Escape") {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;
    // From the box itself or the confirm step's question, Tab starts at an end.
    const onAControl = active !== null && nodes.includes(active);
    if (e.shiftKey ? !onAControl || active === first : !onAControl || active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  if (!shown) return null;
  const one = devices.length === 1;
  const latest = Math.max(...devices.map((d) => d.seen_at));
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal alertdialog; keyboard handled via onKeyDown (Tab trap, Escape held)
    <div
      ref={box}
      className={`kc-device-alert${lowered ? " kc-device-alert--lowered" : ""}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={textId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div id={titleId} className="kc-device-alert__title">
        {one ? "A new device signed in to your account" : `${devices.length} new devices signed in to your account`}
        <span className="kc-device-alert__when"> · {deviceAlertAgo(latest)}</span>
      </div>
      {confirming ? (
        <>
          <p ref={focus.question} id={textId} tabIndex={-1} className="kc-device-alert__text">
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
          <p id={textId} className="kc-device-alert__text">
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
