import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  TWO_FACTOR_EVENT,
  codeKind,
  markTwoFactorChangedHere,
  recoveryCodesText,
  stepUpCodeMessage,
  type RecoveryCodes,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from "../../lib/twoFactor";
import { apiStatus } from "../../lib/apiErrors";

/** What the card asks the server, so tests can stand in for it. */
export type TwoFactorApi = {
  status: () => Promise<TwoFactorStatus>;
  setup: (password: string) => Promise<TwoFactorSetup>;
  enable: (code: string) => Promise<RecoveryCodes>;
  disable: (password: string, code: string) => Promise<void>;
  newRecoveryCodes: (password: string, code: string) => Promise<RecoveryCodes>;
};

type Props = {
  twoFactorApi: TwoFactorApi;
  username: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
  /** Told whenever the status is known or changes, so the tab can ask for codes elsewhere. */
  onStatus?: (status: TwoFactorStatus) => void;
};

type Step =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; setup: TwoFactorSetup }
  | { kind: "codes"; codes: string[] }
  | { kind: "confirm"; action: "disable" | "codes" };

/** A message for a refusal the card can explain; anything else is the generic one. */
function refusal(err: unknown): string {
  const code = stepUpCodeMessage(err);
  if (code) return code;
  switch (apiStatus(err)) {
    case 403:
      return "That isn't your password.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    case 503:
      return "Two-factor sign-in isn't available on this server.";
    case 409:
      return "That changed somewhere else. Close Settings and open it again.";
    default:
      return "That didn't go through. Check your connection and try again.";
  }
}

/** The setup key in groups of four, the way authenticator apps show keys. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Two-factor sign-in in Settings: turn it on (password, scan, a code, save recovery codes),
 *  turn it off or get new recovery codes (password and a code). */
export function TwoFactorCard({ twoFactorApi, username, onToast, onStatus }: Props) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const onStatusRef = useRef(onStatus);
  // Kept current after each commit, not during render.
  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
  });

  function learn(next: TwoFactorStatus) {
    setStatus(next);
    onStatusRef.current?.(next);
  }

  async function load() {
    try {
      learn(await twoFactorApi.status());
      setStep({ kind: "idle" });
    } catch {
      setStep({ kind: "failed" });
    }
  }

  // A change announced by the server: read the status again, but leave any form or recovery
  // codes on screen alone (this device's own change is announced to it too). If the read
  // fails, what's shown stays, unless nothing was shown yet.
  async function refresh() {
    try {
      learn(await twoFactorApi.status());
      setStep((s) => (s.kind === "loading" || s.kind === "failed" ? { kind: "idle" } : s));
    } catch {
      setStep((s) => (s.kind === "loading" ? { kind: "failed" } : s));
    }
  }

  useEffect(() => {
    void load();
    const again = () => void refresh();
    window.addEventListener(TWO_FACTOR_EVENT, again);
    return () => window.removeEventListener(TWO_FACTOR_EVENT, again);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each new form puts the cursor in its first field.
  useEffect(() => {
    if (step.kind === "password" || step.kind === "scan" || step.kind === "confirm") firstField.current?.focus();
  }, [step.kind]);

  function go(next: Step) {
    setStep(next);
    setPassword("");
    setCode("");
    setError(null);
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    void run(async () => {
      const setup = await twoFactorApi.setup(password);
      go({ kind: "scan", setup });
    });
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (codeKind(code) !== "totp") {
      setError("Type the 6 digits your authenticator app shows for Ohiyo.");
      return;
    }
    void run(async () => {
      // Before the request: the server tells every device, this one included, and that can
      // arrive before the answer does.
      markTwoFactorChangedHere();
      const { recovery_codes } = await twoFactorApi.enable(code.replace(/\s/g, ""));
      learn({ enabled: true, available: true, recovery_codes_left: recovery_codes.length });
      go({ kind: "codes", codes: recovery_codes });
      onToast("Two-factor sign-in is on.", "success");
    });
  };

  const submitConfirm = (action: "disable" | "codes") => (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || codeKind(code) === null) {
      setError("Enter your password and a code from your app (or a recovery code).");
      return;
    }
    const typed = codeKind(code) === "totp" ? code.replace(/[\s-]/g, "") : code.trim();
    void run(async () => {
      if (action === "disable") {
        markTwoFactorChangedHere();
        await twoFactorApi.disable(password, typed);
        learn({ enabled: false, available: status?.available ?? true, recovery_codes_left: 0 });
        go({ kind: "idle" });
        onToast("Two-factor sign-in is off.", "info");
      } else {
        const { recovery_codes } = await twoFactorApi.newRecoveryCodes(password, typed);
        learn({ enabled: true, available: true, recovery_codes_left: recovery_codes.length });
        go({ kind: "codes", codes: recovery_codes });
      }
    });
  };

  function download(codes: string[]) {
    const blob = new Blob([recoveryCodesText(codes, username, new Date())], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ohiyo-recovery-codes-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      onToast("Recovery codes copied.", "success");
    } catch {
      onToast("Couldn't copy. Download them instead.", "error");
    }
  }

  const field = "w-full rounded px-3 py-2 text-sm outline-none";
  const fieldStyle = { background: "var(--bg-input)", color: "var(--text-primary)" };
  const primary = { background: "var(--accent)", color: "#fff" };
  const quiet = { background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--bg-hover)" };
  const errorLine = error && (
    <p className="mt-2 text-xs" role="alert" style={{ color: "var(--danger)" }}>
      {error}
    </p>
  );
  const enabled = status?.enabled ?? false;

  return (
    <section className="kc-two-factor mt-4 rounded-lg p-6" style={{ background: "var(--bg-sidebar)" }} aria-labelledby="kc-two-factor-title">
      <div className="mb-1 flex items-center gap-2">
        <h3 id="kc-two-factor-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Two-factor sign-in
        </h3>
        {status && status.available && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-semibold"
            style={enabled ? { background: "color-mix(in oklch, var(--green) 18%, transparent)", color: "var(--green)" } : { background: "var(--bg-input)", color: "var(--text-muted)" }}
          >
            {enabled ? "On" : "Off"}
          </span>
        )}
      </div>

      {step.kind === "loading" && <p className="text-xs" style={{ color: "var(--text-muted)" }}>Checking…</p>}
      {step.kind === "failed" && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Couldn&apos;t check two-factor sign-in.{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {step.kind === "idle" && status && !status.available && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Two-factor sign-in isn&apos;t available on this server yet.
        </p>
      )}

      {step.kind === "idle" && status?.available && !enabled && (
        <>
          <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
            Off. Turn it on and signing in also needs a code from an authenticator app on your phone, so a stolen
            password isn&apos;t enough.
          </p>
          <button type="button" onClick={() => go({ kind: "password" })} className="rounded px-3 py-1.5 text-sm font-semibold" style={primary}>
            Turn on two-factor sign-in
          </button>
        </>
      )}

      {step.kind === "idle" && enabled && status && (
        <>
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Signing in asks for a code from your authenticator app after your password.
          </p>
          <p className="mb-3 text-xs" style={{ color: status.recovery_codes_left <= 2 ? "var(--warning)" : "var(--text-muted)" }}>
            {status.recovery_codes_left === 1 ? "1 recovery code left" : `${status.recovery_codes_left} recovery codes left`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => go({ kind: "confirm", action: "codes" })} className="rounded px-3 py-1.5 text-sm font-semibold" style={quiet}>
              New recovery codes
            </button>
            <button
              type="button"
              onClick={() => go({ kind: "confirm", action: "disable" })}
              className="rounded px-3 py-1.5 text-sm font-semibold"
              style={{ ...quiet, color: "var(--danger)", borderColor: "var(--danger)" }}
            >
              Turn off
            </button>
          </div>
        </>
      )}

      {step.kind === "password" && (
        <form onSubmit={submitPassword} aria-label="Confirm it's you" className="grid gap-2" style={{ maxWidth: 360 }}>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Enter your password to start.
          </p>
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          <input
            ref={firstField}
            type="password"
            autoComplete="current-password"
            aria-label="Password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
            style={fieldStyle}
          />
          {errorLine}
          <div className="flex gap-2">
            <button type="submit" disabled={!password || busy} className="rounded px-3 py-1.5 text-sm font-semibold" style={{ ...primary, opacity: !password || busy ? 0.6 : 1 }}>
              {busy ? "Checking…" : "Continue"}
            </button>
            <button type="button" onClick={() => go({ kind: "idle" })} className="rounded px-3 py-1.5 text-sm" style={quiet}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "scan" && (
        <form onSubmit={submitCode} aria-label="Turn on two-factor sign-in" className="grid gap-3">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            In your authenticator app (Google Authenticator, 1Password, Authy, Aegis…), add an account by scanning this
            code. Then type the 6-digit code it shows.
          </p>
          <div className="flex flex-wrap items-start gap-4">
            <div role="img" aria-label="QR code for your authenticator app" className="kc-two-factor__qr rounded-lg p-3" style={{ background: "#fff" }}>
              <QRCodeSVG value={step.setup.otpauth_url} size={148} marginSize={0} />
            </div>
            <div className="min-w-0 grid gap-1">
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                Can&apos;t scan? Type this key into the app:
              </span>
              <code aria-label="Setup key" className="kc-two-factor__key rounded px-2 py-1 font-mono text-sm" style={{ background: "var(--bg-input)", color: "var(--text-primary)", wordBreak: "break-all" }}>
                {grouped(step.setup.secret)}
              </code>
            </div>
          </div>
          <div className="grid gap-2" style={{ maxWidth: 220 }}>
            <input
              ref={firstField}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit code"
              placeholder="123 456"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${field} text-center font-mono tracking-widest`}
              style={fieldStyle}
            />
          </div>
          {errorLine}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded px-3 py-1.5 text-sm font-semibold" style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Checking…" : "Turn on"}
            </button>
            <button type="button" onClick={() => go({ kind: "idle" })} className="rounded px-3 py-1.5 text-sm" style={quiet}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "codes" && (
        <div className="grid gap-3">
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            <strong>Save these recovery codes.</strong> If you lose your phone, each one signs you in once. They
            won&apos;t be shown again.
          </p>
          <ul className="kc-recovery-codes grid gap-1 rounded-lg p-3 font-mono text-sm" style={{ background: "var(--bg-input)", color: "var(--text-primary)", gridTemplateColumns: "repeat(auto-fill, minmax(12rem, 1fr))" }}>
            {step.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => download(step.codes)} className="rounded px-3 py-1.5 text-sm font-semibold" style={quiet}>
              Download
            </button>
            <button type="button" onClick={() => void copy(step.codes)} className="rounded px-3 py-1.5 text-sm font-semibold" style={quiet}>
              Copy
            </button>
            <button type="button" onClick={() => go({ kind: "idle" })} className="rounded px-3 py-1.5 text-sm font-semibold" style={primary}>
              I&apos;ve saved them
            </button>
          </div>
        </div>
      )}

      {step.kind === "confirm" && (
        <form
          onSubmit={submitConfirm(step.action)}
          aria-label={step.action === "disable" ? "Turn off two-factor sign-in" : "Make new recovery codes"}
          className="grid gap-2"
          style={{ maxWidth: 360 }}
        >
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {step.action === "disable"
              ? "Signing in will need only your password again. Enter your password and a code from your app (or a recovery code)."
              : "Your old recovery codes stop working. Enter your password and a code from your app (or a recovery code)."}
          </p>
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          <input
            ref={firstField}
            type="password"
            autoComplete="current-password"
            aria-label="Password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
            style={fieldStyle}
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Code"
            placeholder="Code from your app"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${field} font-mono`}
            style={fieldStyle}
          />
          {errorLine}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded px-3 py-1.5 text-sm font-semibold"
              style={step.action === "disable" ? { background: "var(--danger-fill, var(--danger))", color: "#fff", opacity: busy ? 0.6 : 1 } : { ...primary, opacity: busy ? 0.6 : 1 }}
            >
              {busy ? "Checking…" : step.action === "disable" ? "Turn off" : "Make new codes"}
            </button>
            <button type="button" onClick={() => go({ kind: "idle" })} className="rounded px-3 py-1.5 text-sm" style={quiet}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
