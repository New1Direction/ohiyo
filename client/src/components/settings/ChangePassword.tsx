import { useState } from "react";
import { api } from "../../api";
import { passwordChangeMessage, PASSWORD_MIN_LENGTH as MIN_LENGTH } from "../../lib/apiErrors";
import { codeKind, stepUpCodeMessage } from "../../lib/twoFactor";

type Props = {
  token: string;
  username: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
  /** The server ended every session and gave this one a fresh token. */
  onChanged: (token: string) => void;
  /** Two-factor sign-in is on, so the change needs a code too. */
  needsCode?: boolean;
};

/** Change the password. Every other session ends, so whoever had the old password, or a
 *  copied session, is signed out. Encryption keys and the recovery backup don't use it. */
export function ChangePassword({ token, username, onToast, onChanged, needsCode = false }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  // The server asked for a code this card didn't know it needed (the status hadn't loaded).
  const [codeAsked, setCodeAsked] = useState(false);
  const showCode = needsCode || codeAsked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    next.length > 0 && next.length < MIN_LENGTH
      ? `Use at least ${MIN_LENGTH} characters.`
      : repeat.length > 0 && repeat !== next
        ? "The two new passwords don't match."
        : next.length > 0 && next === current
          ? "That's the password you have now."
          : null;
  const ready =
    current.length > 0 &&
    next.length >= MIN_LENGTH &&
    repeat === next &&
    next !== current &&
    (!showCode || codeKind(code) !== null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const typed = codeKind(code) === "totp" ? code.replace(/[\s-]/g, "") : code.trim();
      const res = await api.changePassword(token, current, next, showCode ? typed : undefined);
      setCurrent("");
      setNext("");
      setRepeat("");
      setCode("");
      onChanged(res.token);
      onToast("Password changed. You're signed out everywhere else.", "success");
    } catch (err) {
      const codeProblem = stepUpCodeMessage(err);
      if (codeProblem) setCodeAsked(true);
      setError(codeProblem ?? passwordChangeMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded px-3 py-2 text-sm outline-none";
  const fieldStyle = { background: "var(--bg-input)", color: "var(--text-primary)" };
  return (
    <form onSubmit={submit} className="mt-4 rounded-lg p-6" style={{ background: "var(--bg-sidebar)" }} aria-label="Change password">
      <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Password
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Changing it signs you out everywhere else. Your encryption keys and recovery backup don&apos;t use it, so
        nothing to re-set there.
      </p>
      {/* Lets a password manager tie the new password to this account. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <div className="grid gap-2" style={{ maxWidth: 360 }}>
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Current password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={field}
          style={fieldStyle}
        />
        <input
          type="password"
          autoComplete="new-password"
          aria-label="New password"
          placeholder="New password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={field}
          style={fieldStyle}
        />
        <input
          type="password"
          autoComplete="new-password"
          aria-label="New password again"
          placeholder="New password again"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          className={field}
          style={fieldStyle}
        />
        {showCode && (
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Code from your authenticator app"
            placeholder="Code from your authenticator app"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${field} font-mono`}
            style={fieldStyle}
          />
        )}
      </div>
      {(error ?? problem) && (
        <p className="mt-2 text-xs" role="alert" style={{ color: "var(--danger)" }}>
          {error ?? problem}
        </p>
      )}
      <button
        type="submit"
        disabled={!ready || busy}
        className="mt-3 rounded px-3 py-1.5 text-sm font-semibold"
        style={{ background: "var(--accent)", color: "#fff", opacity: !ready || busy ? 0.6 : 1 }}
      >
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
