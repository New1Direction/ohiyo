import { useEffect, useState } from "react";
import { BirdMark } from "./BirdMark";
import type { ConnectionStatus } from "../gateway";

type Props = {
  connStatus: ConnectionStatus;
  onLogout: () => void;
};

const SLOW_AFTER_MS = 6000;

/**
 * Full-screen warm splash shown after auth while the gateway connects and the
 * first `Ready` payload lands. Replaces the flash of empty chrome, and never
 * dead-ends: if connecting drags, it offers a way back to sign-in.
 */
export function BootSplash({ connStatus, onLogout }: Props) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  const stalled = slow || connStatus === "disconnected";

  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-center text-center"
      style={{
        background:
          "radial-gradient(circle at 50% 35%, color-mix(in oklch, var(--accent) 14%, var(--bg-base)) 0%, var(--bg-base) 60%)",
        padding: "var(--space-6)",
      }}
    >
      <div className="kc-loader" style={{ color: "var(--accent)" }}>
        <BirdMark size={56} />
      </div>
      <div
        className="mt-5"
        style={{
          fontFamily: "var(--font-display)", fontWeight: 700,
          fontSize: "var(--text-xl)", color: "var(--text-primary)",
        }}
      >
        {stalled ? "Still reaching the nest…" : "Warming up your space"}
      </div>
      <div className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        {stalled ? "Hang tight — your connection's being shy." : "One moment, this is quick."}
      </div>

      {stalled && (
        <button
          type="button"
          onClick={onLogout}
          className="kc-interactive mt-6 px-4 py-2 text-sm font-semibold"
          style={{
            borderRadius: "var(--radius-md)",
            background: "var(--bg-input)",
            color: "var(--text-secondary)",
          }}
        >
          Back to sign in
        </button>
      )}
    </div>
  );
}
