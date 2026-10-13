import { useState } from "react";
import { api } from "../../api";
import { passwordChangeMessage, PASSWORD_MIN_LENGTH as MIN_LENGTH } from "../../lib/apiErrors";

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
export function ChangePassword({ token, username, onToast, onChanged }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
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
  const ready = current.length > 0 && next.length >= MIN_LENGTH && repeat === next && next !== current;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.changePassword(token, current, next);
      setCurrent("");
      setNext("");
      setRepeat("");
      onChanged(res.token);
      onToast("Password changed. You're signed out everywhere else.", "success");
    } catch (err) {
      setError(passwordChangeMessage(err));
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
