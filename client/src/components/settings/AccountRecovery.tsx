import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { apiStatus, passwordStepMessage } from "../../lib/apiErrors";
import { stepUpCodeMessage } from "../../lib/twoFactor";
import { ConfirmWithPassword } from "./ConfirmWithPassword";

type Props = { token: string; username: string; needsCode: boolean };

/** A user-held password-reset credential, never an encryption key or a 2FA bypass. */
export function AccountRecovery({ token, username, needsCode }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [unsupported, setUnsupported] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [codeAsked, setCodeAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const savedCode = useRef<HTMLElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void api.accountRecoveryStatus(token).then((status) => {
      if (!cancelled) setEnabled(status.enabled);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const unavailable = [404, 405, 501].includes(apiStatus(err) ?? 0);
      setUnsupported(unavailable);
      setError(unavailable
        ? "Account recovery isn't available on this server yet."
        : "Couldn't check account recovery. Check your connection and try again.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  useEffect(() => {
    if (code) savedCode.current?.focus();
    else if (!confirming) trigger.current?.focus();
  }, [code, confirming]);

  async function generate(password: string, twoFactorCode?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.createAccountRecoveryCode(token, password, twoFactorCode);
      if (!alive.current) return;
      setCode(result.recovery_code);
      setEnabled(true);
      setConfirming(false); // Unmount the password and second-factor fields immediately.
    } catch (err) {
      if (!alive.current) return;
      const codeProblem = stepUpCodeMessage(err)?.replace("a recovery code", "a two-factor backup code");
      if (codeProblem && apiStatus(err) === 403) setCodeAsked(true);
      const unavailable = [404, 405, 501].includes(apiStatus(err) ?? 0);
      if (unavailable) {
        setUnsupported(true);
        setConfirming(false);
      }
      setError(unavailable ? "Account recovery isn't available on this server yet."
        : codeProblem ?? passwordStepMessage(err, "Couldn't receive a recovery code. If the request went through, your old code was replaced. Try creating a new code."));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      if (alive.current) setNotice("Account recovery code copied. Keep it somewhere safe.");
    } catch {
      if (alive.current) setError("Couldn't copy. Download the code or write it down instead.");
    }
  }

  function download() {
    if (!code) return;
    try {
      const text = [
        `Ohiyo account recovery code for @${username}`,
        `Created ${new Date().toISOString().slice(0, 10)}`,
        "Use once to reset your password. Your second factor is still required if enabled.",
        "Not a two-factor backup code or an encrypted-chat recovery key.",
        "Create a new code after use or any password change. Keep this private.",
        "", code, "",
      ].join("\n");
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `ohiyo-account-recovery-${username}.txt`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Download requested. Check that the file is saved before continuing.");
    } catch {
      setError("Couldn't download. Copy the code or write it down instead.");
    }
  }

  const primary = { background: "var(--accent)", color: "#fff" };
  return (
    <section className="mt-4 rounded-lg p-6" style={{ background: "var(--bg-sidebar)" }} aria-labelledby="account-recovery-title">
      <h3 id="account-recovery-title" className="mb-1 text-sm font-semibold">Account recovery</h3>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Save a single-use code now so you can reset a forgotten password. Keep it private, somewhere you can reach without signing in.
        If two-factor sign-in is on, you still need your authenticator or a two-factor backup code.
      </p>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        This is not an encrypted-chat recovery key. Resetting your password keeps two-factor sign-in and encrypted backups intact,
        but does not unlock those backups. Create a new account recovery code after using it or changing your password.
      </p>
      {loading && <p role="status" className="text-sm">Checking account recovery…</p>}
      {!loading && enabled !== null && !code && !unsupported && (
        <p className="mb-2 text-xs">{enabled ? "A code is set up. Creating a new one invalidates the old one." : "No account recovery code is set up yet."}</p>
      )}
      {code ? (
        <div className="rounded-md p-3" style={{ border: "1px solid var(--accent)" }}>
          <p className="mb-2 text-sm font-semibold">Save this code now — it is shown only once.</p>
          <code ref={savedCode} tabIndex={-1} aria-label="Your account recovery code" className="block font-mono text-sm" style={{ overflowWrap: "anywhere" }}>{code}</code>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className="rounded px-3 py-2 text-sm" style={primary}>Copy code</button>
            <button type="button" onClick={download} className="rounded px-3 py-2 text-sm" style={primary}>Download code</button>
            <button type="button" onClick={() => { setCode(null); setError(""); setNotice("Code saved. It won't be shown again."); }} className="kc-interactive rounded px-3 py-2 text-sm" style={{ background: "var(--bg-hover)" }}>I've saved it</button>
          </div>
        </div>
      ) : confirming ? (
        <ConfirmWithPassword
          confirmLabel={busy ? "Creating code…" : "Create recovery code"}
          busy={busy}
          needsCode={needsCode || codeAsked}
          onConfirm={generate}
          onCancel={() => { setConfirming(false); setCodeAsked(false); setError(""); }}
        />
      ) : !loading && !unsupported && enabled !== null ? (
        <button ref={trigger} type="button" onClick={() => { setConfirming(true); setError(""); setNotice(""); }} className="rounded px-3 py-2 text-sm font-semibold" style={primary}>
          {enabled ? "Replace account recovery code" : "Set up account recovery"}
        </button>
      ) : null}
      {error && <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
      {!loading && !unsupported && enabled === null && <button type="button" onClick={() => setAttempt((n) => n + 1)} className="kc-interactive mt-2 rounded px-3 py-2 text-sm">Try again</button>}
      {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    </section>
  );
}
