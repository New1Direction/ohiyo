import { useEffect, useState } from "react";
import { BirdMark } from "./BirdMark";

/** How long an unlock may take before the screen explains the likely reason. */
const EXPLAIN_AFTER_MS = 2500;

/** Desktop only: shown while the key vault unlocks, so a signed-in person never sees the
 *  sign-in screen flash by. Usually a blink. It lasts when the operating system asks for a
 *  password before handing over the key, and then says so. */
export function VaultUnlocking() {
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setWaiting(true), EXPLAIN_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  return <VaultUnlockingScreen waiting={waiting} />;
}

export function VaultUnlockingScreen({ waiting }: { waiting: boolean }) {
  return (
    <div
      role="status"
      className="ohiyo-boot-splash ohiyo-vault-wait kc-screen flex w-screen flex-col items-center justify-center text-center"
    >
      <div className="ohiyo-boot-mark" style={{ color: "var(--accent)" }}>
        <BirdMark size={56} />
      </div>
      <div className="ohiyo-vault-wait__title mt-5">Unlocking your keys</div>
      <div className="ohiyo-boot-progress" aria-hidden="true"><span /></div>
      {/* Always there, so the mark above doesn't jump when the explanation arrives. */}
      <p className="ohiyo-vault-wait__why text-sm">
        {waiting && (
          <span>
            Your computer may be asking for your password. That&apos;s Ohiyo opening the keys to your encrypted
            chats, which it keeps in the system keychain. If you see “Always Allow”, choose it and you won&apos;t be
            asked on every launch.
          </span>
        )}
      </p>
    </div>
  );
}
