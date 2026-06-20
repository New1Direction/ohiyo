import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { OhiyoHome } from "../lib/homes";
import { BirdMark } from "./BirdMark";

type Props = {
  home: OhiyoHome;
  homes: OhiyoHome[];
  onAuth: (token: string) => void;
  onSwitchHome: (id: string) => void;
  onAddHome: () => void;
};

type Mode = "login" | "register" | "link";

const LAST_USERNAME_KEY = "kc:last-username";
const MIN_PASSWORD = 8;
const MIN_USERNAME = 2;
const MAX_USERNAME = 32;
const AUTH_FACTS = [
  "Chinchillas take dust baths to keep their fur soft.",
  "Sea otters hold hands so they don’t drift apart.",
  "Ohiyo keeps your chats end-to-end encrypted.",
  "Red pandas use their tails like cozy blankets.",
  "Penguins recognize each other by voice.",
  "No ads. No tracking. Just your people.",
  "Chinchillas can have more than 50 hairs from one follicle.",
  "Foxes use their tails for balance, warmth, and style.",
];

/** Map raw server/network errors to warm, human copy. */
function friendlyError(raw: string, mode: Mode): string {
  const m = raw.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) {
    return "Can't reach Ohiyo right now — check your connection and try again.";
  }
  if (m.includes("username taken")) return "That username's already taken — try another?";
  if (m.includes("invalid credentials")) return "Hmm, that username or password doesn't match.";
  if (m.includes("password")) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (m.includes("username")) return `Usernames are ${MIN_USERNAME}–${MAX_USERNAME} characters.`;
  if (mode === "login") return "Couldn't sign you in. Give it another go?";
  return "Couldn't create your account. Give it another go?";
}

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
  const [username, setUsername] = useState(() => localStorage.getItem(LAST_USERNAME_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkCode, setLinkCode] = useState("");
  const [factIndex, setFactIndex] = useState(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

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

  const usernameOk = username.trim().length >= MIN_USERNAME && username.trim().length <= MAX_USERNAME;
  const passwordOk = password.length >= MIN_PASSWORD;
  const canSubmit = usernameOk && passwordOk && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setLoading(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password, displayName.trim() || undefined);
      localStorage.setItem(LAST_USERNAME_KEY, username.trim());
      onAuth(res.token);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "", mode));
      setLoading(false);
    }
  }

  async function handleLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = linkCode.replace(/[^a-zA-Z0-9]/g, "");
    if (!code || loading) return;
    setError("");
    setLoading(true);
    try {
      const res = await api.completeDeviceLink(code);
      onAuth(res.token);
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
    setMode(next);
    setError("");
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
    <main
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden"
      style={{
        background:
          "radial-gradient(circle at 30% 20%, color-mix(in oklch, var(--accent) 16%, var(--bg-base)) 0%, var(--bg-base) 55%)",
        padding: "var(--space-4)",
      }}
    >
      <div className="ohiyo-auth-sticks" aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) => <span key={`twig-${i}`} />)}
        {Array.from({ length: 30 }, (_, i) => <i key={`leaf-${i}`} />)}
      </div>
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center">
      <div
        className="ohiyo-auth-card w-full"
        style={{
          background: "var(--bg-channel)",
          borderRadius: "var(--radius-xl)",
          padding: "var(--space-8)",
          boxShadow: "var(--shadow-lg)",
          border: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)",
        }}
      >
        {/* Brand */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="kc-float mb-3 flex items-center justify-center"
            style={{
              width: 64, height: 64, borderRadius: "var(--radius-lg)",
              background: "color-mix(in oklch, var(--accent) 14%, transparent)",
              color: "var(--accent)",
            }}
          >
            <BirdMark size={40} />
          </div>
          <div key={mode} className="ohiyo-auth-mode-copy w-full">
            <h1
              style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
            >
              {mode === "login" ? "Welcome back" : mode === "register" ? "Join Ohiyo" : "Link this device"}
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              {mode === "login"
                ? "Good to see you again."
                : mode === "register"
                  ? "Free forever. Takes ten seconds."
                  : "Enter the code from a device you're already signed in on."}
            </p>
            <div
              className="ohiyo-auth-status-pill mt-4 flex w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-xs"
              title={home.url}
              style={{
                background: "color-mix(in oklch, var(--text-primary) 6%, transparent)",
                color: "var(--text-muted)",
                border: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)",
              }}
            >
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: "var(--green)", boxShadow: "0 0 10px color-mix(in oklch, var(--green) 48%, transparent)" }} />
              <span>{mode === "login" ? "Secure Ohiyo sign-in" : mode === "register" ? "Private account setup" : "Safe device link"}</span>
            </div>
          </div>
        </div>

        <div className="ohiyo-auth-form-zone">
        {mode !== "link" && (
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
              className="kc-field px-3.5 py-3 text-sm outline-none"
            />
            {showUsernameHint && (
              <p className="mt-1 px-1 text-xs" aria-live="polite" style={{ color: "var(--text-muted)" }}>
                {username.trim().length < MIN_USERNAME
                  ? `A little longer — ${MIN_USERNAME}+ characters.`
                  : `Keep it under ${MAX_USERNAME} characters.`}
              </p>
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
              className="kc-field px-3.5 py-3 text-sm outline-none"
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
                className="kc-field px-3.5 py-3 pr-11 text-sm outline-none"
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
            className="kc-cta mt-1 flex items-center justify-center gap-2 py-3 text-sm"
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
        </form>
        )}

        {mode === "link" && (
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
              className="kc-cta mt-1 flex items-center justify-center gap-2 py-3 text-sm"
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
            <p className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
              On your other device: <strong>Settings → Privacy &amp; Security → Link a device</strong>.
            </p>
          </form>
        )}
        </div>

        <p className="mt-5 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          {mode === "login" ? (
            <>
              New to Ohiyo?{" "}
              <button type="button" onClick={() => switchMode("register")} className="kc-interactive font-semibold" style={{ color: "var(--accent)" }}>
                Create an account
              </button>
              <br />
              Already signed in elsewhere?{" "}
              <button type="button" onClick={() => switchMode("link")} className="kc-interactive font-semibold" style={{ color: "var(--green)", textShadow: "0 0 12px color-mix(in oklch, var(--green) 30%, transparent)" }}>
                Link a device
              </button>
              <br />
              <span style={{ color: "var(--text-muted)", opacity: 0.85 }}>
                Forgot it? If you saved a recovery code you can{" "}
                <button type="button" onClick={() => switchMode("link")} className="kc-interactive font-semibold" style={{ color: "var(--green)", textShadow: "0 0 12px color-mix(in oklch, var(--green) 28%, transparent)" }}>
                  link a device
                </button>{" "}
                or{" "}
                <button type="button" onClick={() => switchMode("register")} className="kc-interactive font-semibold" style={{ color: "var(--danger)", textShadow: "0 0 12px color-mix(in oklch, var(--danger) 28%, transparent)" }}>
                  start fresh
                </button>
                .
              </span>
            </>
          ) : (
            <>
              Already settled in?{" "}
              <button type="button" onClick={() => switchMode("login")} className="kc-interactive font-semibold" style={{ color: "var(--accent)" }}>
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="ohiyo-trust-text mt-4 text-center text-xs" aria-label="End-to-end encrypted. No ads. No tracking. Yours.">
          <span className="ohiyo-trust-primary">End-to-end encrypted</span>
          <span className="ohiyo-trust-secondary">No ads · No tracking · Yours</span>
        </p>
      </div>
      <p key={factIndex} className="ohiyo-auth-fact mt-4 text-center text-xs" aria-live="off">
        {AUTH_FACTS[factIndex]}
      </p>
      </div>
    </main>
  );
}
