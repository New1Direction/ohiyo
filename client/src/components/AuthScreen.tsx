import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PRIVACY_URL, TERMS_URL } from "../lib/helpLinks";
import sunriseUrl from "../assets/door/sunrise.webp";
import morningUrl from "../assets/door/morning.webp";
import meadowUrl from "../assets/door/meadow.webp";
import nightUrl from "../assets/door/night.webp";
import { doorScene, type DoorSceneKey } from "../lib/doorScene";
import { api } from "../api";
import type { OhiyoHome } from "../lib/homes";
import { BirdMark } from "./BirdMark";
import { markActivation } from "../lib/activation";
import { apiStatus, rateLimitMessage } from "../lib/apiErrors";
import { codeKind, isTwoFactorChallenge, signInCodeMessage, stepUpCodeMessage } from "../lib/twoFactor";
import { takeSignInNotice } from "../lib/sessionNotice";
import {
  friendlyAuthError,
  MAX_USERNAME,
  MIN_PASSWORD,
  MIN_USERNAME,
  USERNAME_RULE,
  usernameProblem,
  type AuthMode,
} from "../lib/authForm";

type Props = {
  home: OhiyoHome;
  homes: OhiyoHome[];
  /** Signed in: the session token and who it belongs to. */
  onAuth: (token: string, userId: string) => void;
  onSwitchHome: (id: string) => void;
  onAddHome: () => void;
};

type Mode = AuthMode;

const LAST_USERNAME_KEY = "kc:last-username";
// One painting per time of day. Sunset is the sunrise painting with an evening grade.
const SCENE_IMAGE: Record<DoorSceneKey, string> = {
  sunrise: sunriseUrl,
  morning: morningUrl,
  day: meadowUrl,
  sunset: sunriseUrl,
  night: nightUrl,
};

const MOTE_COUNT = 14;
/** Where each drifting leaf (or firefly) starts and how it moves. Fixed, so the scene is the same every visit. */
const LIFE: CSSProperties[] = Array.from({ length: MOTE_COUNT }, (_, i) => ({
  ["--x" as string]: `${(i * 37 + 11) % 100}%`,
  ["--y" as string]: `${(i * 53 + 23) % 100}%`,
  ["--dur" as string]: `${9 + (i % 5) * 2.5}s`,
  ["--delay" as string]: `${(-i * 1.7).toFixed(1)}s`,
  ["--size" as string]: `${0.7 + (i % 4) * 0.2}`,
}));

const AUTH_FACTS = [
  "Chinchillas take dust baths to keep their fur soft.",
  "Sea otters hold hands so they don’t drift apart.",
  "Turn on the lock to end-to-end encrypt a DM or group chat.",
  "Red pandas use their tails like cozy blankets.",
  "Penguins recognize each other by voice.",
  "No ads. No tracking. Just your people.",
  "Chinchillas can have more than 50 hairs from one follicle.",
  "Foxes use their tails for balance, warmth, and style.",
];

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export function AuthScreen({ home, onAuth }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [recovering, setRecovering] = useState(false);
  // The hour is read once, when the door opens.
  const [scene] = useState(() => doorScene(new Date().getHours()));
  const [username, setUsername] = useState(() => localStorage.getItem(LAST_USERNAME_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // A reason left by the app when it signed this device out by itself (sessionNotice).
  const [error, setError] = useState("");
  // A reason left by the app when it signed this device out by itself (sessionNotice, e.g.
  // the account was deleted): news, said calmly, not an error.
  const [notice, setNotice] = useState(() => takeSignInNotice() ?? "");
  const [loading, setLoading] = useState(false);
  const [linkCode, setLinkCode] = useState("");
  const [factIndex, setFactIndex] = useState(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // Two-factor sign-in: the password was right and the server wants a code for this challenge.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // A scanned QR opens the app with ?link=<code> — jump straight to the link form.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("link");
    if (code) {
      setLinkCode(code);
      setMode("link");
      // Don't leave the code sitting in the URL / browser history.
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (username) document.getElementById("kc-password")?.focus();
    else usernameRef.current?.focus();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usernameIssue = usernameProblem(username, mode);
  const usernameOk = usernameIssue === null;
  const passwordOk = password.length >= MIN_PASSWORD;
  const canSubmit = usernameOk && passwordOk && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password, displayName.trim() || undefined);
      localStorage.setItem(LAST_USERNAME_KEY, username.trim());
      if (isTwoFactorChallenge(res)) {
        // No session yet: the code step comes next.
        setChallenge(res.challenge);
        setCode("");
        setUseRecovery(false);
        setLoading(false);
        return;
      }
      if (mode === "register") markActivation(res.user.id, "account");
      onAuth(res.token, res.user.id);
    } catch (err) {
      setError(rateLimitMessage(err) ?? friendlyAuthError(err instanceof Error ? err.message : "", mode));
      setLoading(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (challenge === null || loading) return;
    const typed = code.trim();
    const kind = codeKind(typed);
    if (kind === null) {
      setError(useRecovery ? "A recovery code is 16 letters and numbers." : "Type the 6 digits from your authenticator app.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await api.loginTwoFactor(challenge, kind === "totp" ? typed.replace(/[\s-]/g, "") : typed);
      onAuth(res.token, res.user.id);
    } catch (err) {
      setError(signInCodeMessage(err));
      // The challenge ran out or gave up: back to the password.
      if (apiStatus(err) === 401) {
        setChallenge(null);
        setPassword("");
      }
      setLoading(false);
    }
  }

  function leaveCodeStep() {
    setChallenge(null);
    setCode("");
    setError("");
  }

  // The code field gets the cursor as soon as it appears, and again when switching kinds.
  useEffect(() => {
    if (challenge !== null) codeRef.current?.focus();
  }, [challenge, useRecovery]);

  async function handleLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = linkCode.replace(/[^a-zA-Z0-9]/g, "");
    if (!code || loading) return;
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const res = await api.completeDeviceLink(code);
      onAuth(res.token, res.user.id);
    } catch (err) {
      const m = err instanceof Error ? err.message.toLowerCase() : "";
      setError(
        m.includes("invalid") || m.includes("expired") || m.includes("not found") || m.includes("used")
          ? "That code isn't valid or has expired — generate a fresh one on your other device."
          : m.includes("too many")
            ? "Too many tries — give it a moment and try again."
            : m.includes("failed to fetch") || m.includes("load failed")
              ? "Can't reach Ohiyo right now — check your connection."
              : "Couldn't link this device. Try again?"
      );
      setLoading(false);
    }
  }

  // Focus the code field whenever we enter link mode (replaces the autoFocus prop).
  useEffect(() => {
    if (mode === "link") linkRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFactIndex((i) => (i + 1) % AUTH_FACTS.length);
    }, 7200);
    return () => window.clearInterval(timer);
  }, []);

  function switchMode(next: Mode) {
    setRecovering(false);
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setShowPassword(false);
    setLinkCode("");
    setChallenge(null);
    setCode("");
    setUseRecovery(false);
  }

  function onPasswordKey(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  // Only show validation nudges once the field has content — never nag an empty form.
  const showUsernameHint = username.length > 0 && !usernameOk;
  const passwordHintColor = !password
    ? "var(--text-muted)"
    : passwordOk
      ? "var(--green)"
      : "var(--text-muted)";

  return (
    <main className="ohiyo-door kc-screen" data-scene={scene.key} data-tone={scene.tone}>
      {/* The painting for this hour, with a few leaves (or, at night, fireflies) drifting over it. */}
      <div className="ohiyo-door__sky" aria-hidden="true">
        <img src={SCENE_IMAGE[scene.key]} alt="" decoding="async" />
        <div className="ohiyo-door__life">
          {LIFE.map((mote, i) => <span key={i} style={mote} />)}
        </div>
      </div>
      <div className="ohiyo-door__stage">
        <div className="ohiyo-door__panel">
          <div className="ohiyo-door__brand">
            <BirdMark size={30} />
            <span>o<b>Hi</b>Yo</span>
          </div>
          <div key={recovering ? "recover" : challenge !== null ? "two-factor" : mode} className="ohiyo-auth-mode-copy">
            <h1 className="ohiyo-door__greeting">
              {recovering ? "Reset your password" : challenge !== null
                ? "One more step"
                : mode === "login" ? scene.greeting : mode === "register" ? "Join Ohiyo" : "Link this device"}
            </h1>
            <p className="ohiyo-door__line">
              {recovering ? "Use the account recovery code you saved in Settings → My account." : challenge !== null
                ? useRecovery
                  ? "Type one of the recovery codes you saved when you turned on two-factor sign-in."
                  : "Open your authenticator app and type the 6-digit code for Ohiyo."
                : mode === "login"
                ? scene.line
                : mode === "register"
                  ? "Free forever. Takes ten seconds."
                  : "Enter the code from a device you're already signed in on."}
            </p>
            <div className="ohiyo-auth-status-pill" title={home.url}>
              <span aria-hidden className="ohiyo-door__dot" />
              <span>{recovering ? "Account recovery" : mode === "login" ? "Secure Ohiyo sign-in" : mode === "register" ? "Private account setup" : "Safe device link"}</span>
            </div>
          </div>
        <div className="ohiyo-auth-form-zone">
        {recovering && (
          <AccountRecoveryForm
            initialUsername={username}
            onCancel={() => { switchMode("login"); window.requestAnimationFrame(() => usernameRef.current?.focus()); }}
            onLink={() => switchMode("link")}
            onRecovered={(name) => {
              switchMode("login");
              setUsername(name);
              setNotice("Password reset. Sign in with your new password, then save a new account recovery code in Settings → Account. All previous sessions and pending device links have ended.");
              window.requestAnimationFrame(() => document.getElementById("kc-password")?.focus());
            }}
          />
        )}
        {challenge !== null && (
          <form key="two-factor" onSubmit={handleCodeSubmit} className="ohiyo-auth-mode-panel flex flex-col gap-3" aria-label="Two-factor code" autoComplete="off">
            <input
              ref={codeRef}
              id="kc-two-factor-code"
              type="text"
              aria-label={useRecovery ? "Recovery code" : "Code from your authenticator app"}
              placeholder={useRecovery ? "XXXX-XXXX-XXXX-XXXX" : "123 456"}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError("");
              }}
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete={useRecovery ? "off" : "one-time-code"}
              autoCapitalize={useRecovery ? "characters" : "off"}
              autoCorrect="off"
              spellCheck={false}
              maxLength={useRecovery ? 24 : 7}
              data-no-native-autocomplete="true"
              className="kc-field px-3.5 py-3 text-center font-mono text-base tracking-widest outline-none"
            />
            {error && (
              <div
                className="kc-shake px-3 py-2 text-xs"
                style={{
                  background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                  color: "var(--danger)",
                  borderRadius: "var(--radius-md)",
                  fontWeight: 500,
                }}
                role="alert"
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading || codeKind(code) === null}
              className="kc-cta mt-1 flex items-center justify-center gap-2 py-3 text-base"
              style={{
                opacity: loading || codeKind(code) === null ? 0.65 : 1,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {loading ? (
                <span
                  className="kc-spinner"
                  style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }}
                />
              ) : (
                "Sign in"
              )}
            </button>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <button
                type="button"
                className="ohiyo-door__link"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode("");
                  setError("");
                }}
              >
                {useRecovery ? "Use the code from my app" : "Use a recovery code instead"}
              </button>
              <button type="button" className="ohiyo-door__link" onClick={leaveCodeStep}>
                Back
              </button>
            </div>
          </form>
        )}
        {!recovering && challenge === null && mode !== "link" && (
        <form
          key={mode}
          onSubmit={handleSubmit}
          className="ohiyo-auth-mode-panel flex flex-col gap-3"
          aria-label={mode === "login" ? "Sign in" : "Create account"}
          autoComplete="off"
        >
          <div>
            <input
              ref={usernameRef}
              id="kc-username"
              type="text"
              placeholder="Username"
              aria-label="Username"
              name="username"
              value={username}
              onChange={(e) => { setUsername(e.target.value); if (error) setError(""); }}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              data-no-native-autocomplete="true"
              spellCheck={false}
              required
              minLength={MIN_USERNAME}
              maxLength={MAX_USERNAME}
              className="kc-field px-3.5 py-3 text-base outline-none"
            />
            {showUsernameHint ? (
              <p className="mt-1 px-1 text-xs" aria-live="polite" style={{ color: "var(--text-muted)" }}>
                {usernameIssue}
              </p>
            ) : (
              mode === "register" && (
                <p className="mt-1 px-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  {USERNAME_RULE}
                </p>
              )
            )}
          </div>

          {mode === "register" && (
            <input
              id="kc-displayname"
              type="text"
              placeholder="Display name (optional)"
              aria-label="Display name (optional)"
              name="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
              data-no-native-autocomplete="true"
              maxLength={48}
              className="kc-field px-3.5 py-3 text-base outline-none"
            />
          )}

          <div>
            <div className="relative">
              <input
                id="kc-password"
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                aria-label="Password"
                name="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
                onKeyDown={onPasswordKey}
                onKeyUp={onPasswordKey}
                onBlur={() => setCapsLock(false)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                data-no-native-autocomplete="true"
                required
                minLength={MIN_PASSWORD}
                className="kc-field px-3.5 py-3 pr-11 text-base outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="kc-interactive absolute right-2 top-1/2 -translate-y-1/2 p-1.5"
                style={{ color: "var(--text-muted)", background: "none", border: "none" }}
              >
                <EyeIcon off={showPassword} />
              </button>
            </div>

            {mode === "register" && (
              <p className="mt-1 px-1 text-xs" aria-live="polite" style={{ color: passwordHintColor, fontWeight: passwordOk ? 600 : 400 }}>
                {passwordOk ? "✓ Strong enough — you're good." : `At least ${MIN_PASSWORD} characters.`}
              </p>
            )}
            {capsLock && (
              <p className="mt-1 px-1 text-xs font-semibold" aria-live="polite" style={{ color: "#E8A23D" }}>
                ⇪ Caps Lock is on.
              </p>
            )}
          </div>

          {notice && !error && (
            <p
              className="px-3 py-2 text-xs"
              style={{
                background: "color-mix(in oklch, var(--text-primary) 8%, transparent)",
                color: "var(--text-primary)",
                borderRadius: "var(--radius-md)",
              }}
              role="status"
            >
              {notice}
            </p>
          )}
          {error && (
            <div
              className="kc-shake px-3 py-2 text-xs"
              style={{
                background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                color: "var(--danger)",
                borderRadius: "var(--radius-md)",
                fontWeight: 500,
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            aria-busy={loading}
            className="kc-cta mt-1 flex items-center justify-center gap-2 py-3 text-base"
            style={{ opacity: canSubmit ? 1 : 0.65, cursor: canSubmit ? "pointer" : "default" }}
          >
            {loading ? (
              <span className="kc-spinner" style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }} />
            ) : mode === "login" ? (
              "Sign in"
            ) : (
              "Create my account"
            )}
          </button>
          {mode === "register" && (
            <p className="ohiyo-auth-terms text-xs" style={{ color: "var(--text-muted)" }}>
              By creating an account you agree to the{" "}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)" }}>Terms</a>
              {" "}and the{" "}
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)" }}>Privacy Policy</a>.
              {" "}After joining, save an account recovery code in Settings → Account.
            </p>
          )}
        </form>
        )}

        {challenge === null && mode === "link" && (
          <form key="link" onSubmit={handleLinkSubmit} className="ohiyo-auth-mode-panel flex flex-col gap-3" aria-label="Link a device" autoComplete="off">
            <input
              ref={linkRef}
              id="kc-linkcode"
              type="text"
              placeholder="Device-link code"
              aria-label="Device-link code"
              value={linkCode}
              onChange={(e) => {
                setLinkCode(e.target.value);
                if (error) setError("");
              }}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              data-no-native-autocomplete="true"
              autoCorrect="off"
              spellCheck={false}
              className="kc-field px-3.5 py-3 text-center font-mono text-base tracking-widest outline-none"
            />
            {error && (
              <div
                className="kc-shake px-3 py-2 text-xs"
                style={{
                  background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                  color: "var(--danger)",
                  borderRadius: "var(--radius-md)",
                  fontWeight: 500,
                }}
                role="alert"
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading || linkCode.replace(/[^a-zA-Z0-9]/g, "").length < 8}
              className="kc-cta mt-1 flex items-center justify-center gap-2 py-3 text-base"
              style={{
                opacity: loading || linkCode.replace(/[^a-zA-Z0-9]/g, "").length < 8 ? 0.65 : 1,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {loading ? (
                <span
                  className="kc-spinner"
                  style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }}
                />
              ) : (
                "Link this device"
              )}
            </button>
            <p className="text-center text-base leading-relaxed" style={{ color: "var(--text-muted)" }}>
              On your other device: <strong>Settings → Privacy &amp; security → Link a device</strong>.
            </p>
          </form>
        )}
        </div>

          <div className="ohiyo-door__links" hidden={challenge !== null || recovering}>
            {mode === "login" ? (
              <>
                <p>
                  New to Ohiyo?{" "}
                  <button type="button" onClick={() => switchMode("register")} className="ohiyo-door__link">
                    Create an account
                  </button>
                </p>
                <p>
                  Already signed in elsewhere?{" "}
                  <button type="button" onClick={() => switchMode("link")} className="ohiyo-door__link">
                    Link a device
                  </button>
                </p>
                <p>
                  <button type="button" disabled={loading} onClick={() => { switchMode("login"); setRecovering(true); }} className="ohiyo-door__link">
                    Forgot your password?
                  </button>
                </p>
              </>
            ) : (
              <p>
                Already settled in?{" "}
                <button type="button" onClick={() => switchMode("login")} className="ohiyo-door__link">
                  Sign in
                </button>
              </p>
            )}
          </div>

          <p className="ohiyo-door__trust" aria-label="Optional end-to-end encrypted DMs. No ads. No tracking. Yours.">
            No ads · No tracking · Yours
          </p>
        </div>
      </div>
      <p key={factIndex} className="ohiyo-door__fact" aria-live="off">
        {AUTH_FACTS[factIndex]}
      </p>
    </main>
  );
}

/** Unmounting this form drops every secret; a late response cannot sign in or navigate. */
function AccountRecoveryForm({ initialUsername, onCancel, onLink, onRecovered }: {
  initialUsername: string;
  onCancel: () => void;
  onLink: () => void;
  onRecovered: (username: string) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [secondFactor, setSecondFactor] = useState("");
  const [codeAsked, setCodeAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const secondFactorInput = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => { alive.current = false; };
  }, []);

  const validCode = codeKind(secondFactor);
  const ready = username.trim().length > 0 && recoveryCode.trim().length > 0 && password.length >= MIN_PASSWORD
    && password === repeat && (!codeAsked && !secondFactor.trim() || validCode !== null) && !busy && !unsupported;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const code = validCode === "totp" ? secondFactor.replace(/[\s-]/g, "") : secondFactor.trim();
      await api.recoverAccount(username.trim(), recoveryCode.trim(), password, code || undefined);
      if (alive.current) onRecovered(username.trim()); // No token is returned, and no onAuth call.
    } catch (err) {
      if (!alive.current) return;
      const status = apiStatus(err);
      const codeProblem = stepUpCodeMessage(err)?.replace("a recovery code", "a two-factor backup code");
      if (codeProblem && status === 403) {
        setCodeAsked(true);
        secondFactorInput.current?.focus();
      }
      const unavailable = [404, 405, 501].includes(status ?? 0);
      setUnsupported(unavailable);
      setError(unavailable ? "Account recovery isn't available on this server yet. You can still link from a signed-in device."
        : codeProblem ?? rateLimitMessage(err) ?? (status === 401 || status === 403
          ? "Check your username, account recovery code, and second factor (if enabled). The account recovery code may already have been used or replaced."
          : status === 400 ? `Check your details and use at least ${MIN_PASSWORD} characters for the new password.`
            : "Couldn't confirm the reset. Check your connection. If your code no longer works, try signing in with the new password; the reset may have completed."));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const field = "kc-field w-full px-3.5 py-3 text-base outline-none";
  return (
    <form onSubmit={submit} className="ohiyo-auth-mode-panel flex flex-col gap-3" aria-label="Recover account" autoComplete="off">
      <label className="text-xs">Username
        <input ref={input} type="text" name="username" aria-label="Username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
      </label>
      <label className="text-xs">Account recovery code
        <input type="password" aria-label="Account recovery code" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} className={field} />
      </label>
      <label className="text-xs">New password
        <input type="password" name="new-password" aria-label="New password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
      </label>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>Use at least {MIN_PASSWORD} characters.</p>
      <label className="text-xs">New password again
        <input type="password" aria-label="New password again" autoComplete="new-password" required minLength={MIN_PASSWORD} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={field} />
      </label>
      {repeat && repeat !== password && <p role="status" className="text-xs">The two new passwords don't match.</p>}
      <label className="text-xs">Authenticator code or two-factor backup code (if enabled)
        <input ref={secondFactorInput} type="text" aria-label="Authenticator code or two-factor backup code" autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} required={codeAsked} value={secondFactor} onChange={(e) => setSecondFactor(e.target.value)} className={field} />
      </label>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Your account recovery code works once. This signs out all devices and cancels pending device links, but keeps two-factor sign-in on.
        Encrypted-chat recovery keys are separate; your encrypted backups stay unchanged.
      </p>
      {error && <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
      <button type="submit" disabled={!ready} aria-busy={busy} className="kc-cta py-3 text-base" style={{ opacity: ready ? 1 : 0.65 }}>{busy ? "Resetting password…" : "Reset password"}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="ohiyo-door__link">Back to sign in</button>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>No saved account recovery code? If you're signed in elsewhere, you can still link this device. Ohiyo can't retrieve a lost code.</p>
      <button type="button" disabled={busy} onClick={onLink} className="ohiyo-door__link">Link a device instead</button>
    </form>
  );
}
