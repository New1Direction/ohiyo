import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BirdMark } from "./BirdMark";

type Props = {
  /** Creates the server. Should throw on failure so we can surface the message. */
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
};

const SUGGESTIONS = ["My Crew", "Game Night", "Study Room", "Project Crew"];

/** Branded "create a space" modal — replaces the old window.prompt. */
export function CreateServerModal({ onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name field once, on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape-to-close (guarded while a create is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Keep Tab focus inside the dialog.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = e.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])'
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const trimmed = name.trim();
  const initials = trimmed
    ? trimmed.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").slice(0, 2).join("")
    : "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create your space — try again.");
      setBusy(false);
    }
  }

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- dismiss scrim; Escape closes via the dialog key handler
    <div className="kc-backdrop" onMouseDown={() => !busy && onClose()}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focus-trap dialog container; keyboard handled via onKeyDown */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kc-create-server-title"
        className="kc-modal max-w-md"
        style={{ padding: "var(--space-8)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="flex flex-col items-center text-center">
          <div
            className="mb-3 flex items-center justify-center"
            style={{
              width: 72, height: 72, borderRadius: "var(--radius-lg)",
              background: trimmed ? "var(--accent)" : "color-mix(in oklch, var(--accent) 14%, transparent)",
              color: trimmed ? "#fff" : "var(--accent)",
              fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)",
              transition: "background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
            }}
          >
            {initials || <BirdMark size={40} />}
          </div>
          <h2
            id="kc-create-server-title"
            style={{
              fontFamily: "var(--font-display)", fontWeight: 700,
              fontSize: "var(--text-2xl)", color: "var(--text-primary)",
            }}
          >
            Create your space
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)", maxWidth: 320 }}>
            Name it once. Ohiyo will add #general, voice, and a launch checklist automatically.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
          <input
            ref={inputRef}
            className="kc-field px-3.5 py-3 text-sm outline-none"
            placeholder="e.g. My Crew"
            value={name}
            maxLength={64}
            onChange={(e) => { setName(e.target.value); if (error) setError(""); }}
            aria-label="Server name"
          />

          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setName(s); inputRef.current?.focus(); }}
                className="kc-interactive px-2.5 py-1 text-xs font-semibold"
                style={{
                  borderRadius: "var(--radius-full)",
                  background: "var(--bg-input)",
                  color: "var(--text-secondary)",
                  border: "1px solid transparent",
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {error && (
            <div
              role="alert"
              className="kc-shake px-3 py-2 text-xs"
              style={{
                background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                color: "var(--danger)", borderRadius: "var(--radius-md)", fontWeight: 500,
              }}
            >
              {error}
            </div>
          )}

          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="kc-interactive flex-shrink-0 px-4 py-3 text-sm font-semibold"
              style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!trimmed || busy}
              className="kc-cta flex flex-1 items-center justify-center gap-2 py-3 text-sm"
              style={{ opacity: !trimmed || busy ? 0.65 : 1, cursor: !trimmed || busy ? "default" : "pointer" }}
            >
              {busy ? (
                <span className="kc-spinner" style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }} />
              ) : (
                "Create space"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
