import { useLayoutEffect, useRef, useState } from "react";
import { codeKind } from "../../lib/twoFactor";

type Props = {
  /** What the confirm button says, e.g. "Back up my keys". */
  confirmLabel: string;
  busy?: boolean;
  needsCode?: boolean;
  onConfirm: (password: string, twoFactorCode?: string) => void | Promise<void>;
  onCancel: () => void;
};

/** Asks for the account's password again before an action a stolen session must not take
 *  on its own; the server checks it. Shown in place, under the button that asked. */
export function ConfirmWithPassword({ confirmLabel, busy = false, needsCode = false, onConfirm, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const previouslyNeededCode = useRef(needsCode);
  const ready = password.length > 0 && !busy && (!needsCode || codeKind(code) !== null);

  // Opened by a button just pressed: put the cursor where the password goes.
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (needsCode && !previouslyNeededCode.current) codeInput.current?.focus();
    previouslyNeededCode.current = needsCode;
  }, [needsCode]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = codeKind(code) === "totp" ? code.replace(/[\s-]/g, "") : code.trim();
    if (ready) void onConfirm(password, needsCode ? typed : undefined);
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
      {needsCode && (
        <label className="flex w-full flex-col gap-1 text-xs">
          Authenticator code or two-factor backup code
          <input
            ref={codeInput}
            type="text"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Authenticator code or two-factor backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded px-3 py-2 text-base outline-none"
            style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
          />
        </label>
      )}
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
