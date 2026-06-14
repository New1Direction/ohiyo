import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { BirdMark } from "./BirdMark";

type Props = {
  onAuth: (token: string) => void;
};

type Mode = "login" | "register";

const LAST_USERNAME_KEY = "kc:last-username";
const MIN_PASSWORD = 8;
const MIN_USERNAME = 2;
const MAX_USERNAME = 32;

/** Map raw server/network errors to warm, human copy. */
function friendlyError(raw: string, mode: Mode): string {
  const m = raw.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) {
    return "Can't reach Kikkacord right now — check your connection and try again.";
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

export function AuthScreen({ onAuth }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState(() => localStorage.getItem(LAST_USERNAME_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  // Autofocus: username when empty, otherwise jump to password (returning user).
  useEffect(() => {
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
      className="flex h-screen w-screen items-center justify-center"
      style={{
        background:
          "radial-gradient(circle at 30% 20%, color-mix(in oklch, var(--accent) 16%, var(--bg-base)) 0%, var(--bg-base) 55%)",
        padding: "var(--space-4)",
      }}
    >
      <div
        className="kc-fade-up w-full max-w-sm"
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
          <h1
            style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
          >
            {mode === "login" ? "Welcome back" : "Join Kikkacord"}
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            {mode === "login" ? "Good to see you again." : "Free forever. Takes ten seconds."}
          </p>
        </div>

        <form key={mode} onSubmit={handleSubmit} className="kc-fade-up flex flex-col gap-3" aria-label={mode === "login" ? "Sign in" : "Create account"}>
          <div>
            <input
              ref={usernameRef}
              id="kc-username"
              type="text"
              placeholder="Username"
              aria-label="Username"
              value={username}
              onChange={(e) => { setUsername(e.target.value); if (error) setError(""); }}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              minLength={MIN_USERNAME}
              maxLength={MAX_USERNAME}
              className="kc-field px-3.5 py-3 text-sm outline-none"
            />
            {showUsernameHint && (
              <p className="mt-1 px-1 text-xs" style={{ color: "var(--text-muted)" }}>
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
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
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
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
                onKeyDown={onPasswordKey}
                onKeyUp={onPasswordKey}
                onBlur={() => setCapsLock(false)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
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
              <p className="mt-1 px-1 text-xs" style={{ color: passwordHintColor, fontWeight: passwordOk ? 600 : 400 }}>
                {passwordOk ? "✓ Strong enough — you're good." : `At least ${MIN_PASSWORD} characters.`}
              </p>
            )}
            {capsLock && (
              <p className="mt-1 px-1 text-xs font-semibold" style={{ color: "#E8A23D" }}>
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

        <p className="mt-5 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          {mode === "login" ? (
            <>
              New to Kikkacord?{" "}
              <button onClick={() => switchMode("register")} className="kc-interactive font-semibold" style={{ color: "var(--accent)" }}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already flying with us?{" "}
              <button onClick={() => switchMode("login")} className="kc-interactive font-semibold" style={{ color: "var(--accent)" }}>
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="mt-4 text-center text-xs" style={{ color: "var(--text-muted)", opacity: 0.8 }}>
          No ads · No tracking · Your data stays yours
        </p>
      </div>
    </main>
  );
}
