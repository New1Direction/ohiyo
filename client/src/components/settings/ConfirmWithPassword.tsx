import { useLayoutEffect, useRef, useState } from "react";

type Props = {
  /** What the confirm button says, e.g. "Back up my keys". */
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (password: string) => void | Promise<void>;
  onCancel: () => void;
};

/** Asks for the account's password again before an action a stolen session must not take
 *  on its own; the server checks it. Shown in place, under the button that asked. */
export function ConfirmWithPassword({ confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ready = password.length > 0 && !busy;

  // Opened by a button just pressed: put the cursor where the password goes.
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (ready) void onConfirm(password);
  }

  return (
    <form onSubmit={submit} aria-label="Confirm with your password" className="mt-2 mb-3 flex flex-wrap items-center gap-2">
      <input
        type="password"
        autoComplete="current-password"
        aria-label="Your password"
        placeholder="Your password"
        ref={input}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded px-3 py-1.5 text-sm outline-none"
        style={{ background: "var(--bg-input)", color: "var(--text-primary)", minWidth: 180 }}
      />
      <button
        type="submit"
        disabled={!ready}
        className="rounded px-3 py-1.5 text-sm font-semibold"
        style={{ background: "var(--accent)", color: "#fff", opacity: ready ? 1 : 0.6 }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="kc-interactive rounded px-3 py-1.5 text-sm"
        style={{ color: "var(--text-secondary)", background: "var(--bg-hover)" }}
      >
        Cancel
      </button>
    </form>
  );
}
