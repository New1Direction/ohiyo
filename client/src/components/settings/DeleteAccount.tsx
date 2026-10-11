import { useState } from "react";
import { api } from "../../api";
import { deleteAccountMessage } from "../../lib/apiErrors";

type Props = {
  token: string;
  username: string;
  /** The account is gone on the server: sign this device out and clear what's left. */
  onDeleted: () => void;
};

/** Delete the account, for good and at once. Closed until asked for; then it says what
 *  happens, and needs the password and the username typed out. */
export function DeleteAccount({ token, username, onDeleted }: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = password.length > 0 && typed === username;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(token, password, typed);
      onDeleted();
    } catch (err) {
      setError(deleteAccountMessage(err));
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
        <li>Instant Servers you run are shut down and deleted.</li>
        <li>Your encryption keys and recovery backup are deleted, here and on the server.</li>
        <li>It happens at once. It can&apos;t be undone, and Ohiyo can&apos;t bring anything back.</li>
      </ul>
      <div className="grid gap-2" style={{ maxWidth: 360 }}>
        <input
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
            spellCheck={false}
            aria-label="Type your username to confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={`${field} mt-1`}
            style={fieldStyle}
          />
        </label>
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
          style={{ background: "var(--danger)", color: "#fff", opacity: !ready || busy ? 0.6 : 1 }}
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
