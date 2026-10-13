import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { deleteAccountMessage } from "../../lib/apiErrors";
import { codeKind, stepUpCodeMessage } from "../../lib/twoFactor";

type Props = {
  token: string;
  username: string;
  /** The account is gone on the server: sign this device out and clear what's left. */
  onDeleted: () => void;
  /** Two-factor sign-in is on, so deleting needs a code too. */
  needsCode?: boolean;
};

/** Delete the account, for good and at once. Closed until asked for; then it says what
 *  happens, and needs the password and the username typed out. */
export function DeleteAccount({ token, username, onDeleted, needsCode = false }: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [code, setCode] = useState("");
  // The server asked for a code this form didn't know it needed (the status hadn't loaded).
  const [codeAsked, setCodeAsked] = useState(false);
  const showCode = needsCode || codeAsked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Typing the name is a deliberate step, not a password: a phone's capital first letter
  // or trailing space shouldn't block it. The server is sent the account's own username.
  const ready =
    password.length > 0 &&
    typed.trim().toLowerCase() === username.toLowerCase() &&
    (!showCode || codeKind(code) !== null);
  // Opening the form removes the button that opened it: the cursor goes to the first field.
  const passwordField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (open) passwordField.current?.focus();
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sentCode = codeKind(code) === "totp" ? code.replace(/[\s-]/g, "") : code.trim();
      await api.deleteAccount(token, password, username, showCode ? sentCode : undefined);
      onDeleted();
    } catch (err) {
      const codeProblem = stepUpCodeMessage(err);
      if (codeProblem) setCodeAsked(true);
      setError(codeProblem ? `${codeProblem} Nothing was deleted.` : deleteAccountMessage(err));
      setBusy(false);
    }
  }

  const box = { background: "var(--bg-sidebar)", border: "1px solid color-mix(in oklch, var(--danger) 35%, transparent)" };
  if (!open) {
    return (
      <div className="mt-4 rounded-lg p-6" style={box}>
        <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Delete account
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          Removes your account and everything you sent, for good.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded px-3 py-1.5 text-sm font-semibold"
          style={{ color: "var(--danger)", background: "transparent", border: "1px solid var(--danger)" }}
        >
          Delete account…
        </button>
      </div>
    );
  }

  const field = "w-full rounded px-3 py-2 text-sm outline-none";
  const fieldStyle = { background: "var(--bg-input)", color: "var(--text-primary)" };
  return (
    <form onSubmit={submit} className="mt-4 rounded-lg p-6" style={box} aria-label="Delete account">
      <div className="mb-2 text-sm font-semibold" style={{ color: "var(--danger)" }}>
        Delete your account
      </div>
      <ul className="mb-3 grid list-disc gap-1 pl-5 text-xs" style={{ color: "var(--text-secondary)" }}>
        <li>Every message you sent is deleted, for everyone.</li>
        <li>
          Spaces you own go to their longest-standing member. A space with nobody else in it is deleted with
          everything in it.
        </li>
        <li>Group chats you started go to the next person in them.</li>
        <li>In your one-to-one chats, the other person sees &ldquo;Deleted account&rdquo; and can&apos;t reply.</li>
        <li>Instant Servers you run are shut down and deleted.</li>
        <li>Your encryption keys and recovery backup are deleted, here and on the server.</li>
        <li>Your username becomes free, and someone else can take it.</li>
        <li>It happens at once. It can&apos;t be undone, and Ohiyo can&apos;t bring anything back.</li>
      </ul>
      <div className="grid gap-2" style={{ maxWidth: 360 }}>
        <input
          ref={passwordField}
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={field}
          style={fieldStyle}
        />
        <label className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Type <strong style={{ color: "var(--text-primary)" }}>{username}</strong> to confirm
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Type your username to confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={`${field} mt-1`}
            style={fieldStyle}
          />
        </label>
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
      {error && (
        <p className="mt-2 text-xs" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!ready || busy}
          className="rounded px-3 py-1.5 text-sm font-semibold"
          style={{ background: "var(--danger-fill)", color: "#fff", opacity: !ready || busy ? 0.6 : 1 }}
        >
          {busy ? "Deleting…" : "Delete my account"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setPassword("");
            setTyped("");
            setCode("");
            setError(null);
          }}
          className="rounded px-3 py-1.5 text-sm"
          style={{ color: "var(--text-secondary)", background: "var(--bg-hover)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
