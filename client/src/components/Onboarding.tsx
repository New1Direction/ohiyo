import { useEffect, useRef, useState } from "react";
import { BirdMark } from "./BirdMark";
import { ACCENT_PRESETS, getActiveAccent } from "../lib/appearance";

type Props = {
  displayName: string;
  /** Creates the first server and drops the user into it. Throws on failure. */
  onCreate: (name: string) => Promise<void>;
  onSkip: () => void;
  /** Apply (and sync) a personal accent picked during onboarding. */
  onPickAccent?: (hex: string) => void;
};

const SUGGESTIONS = ["My Hangout", "Study Group", "Game Night"];

const VALUE_BULLETS: { icon: string; title: string; body: string }[] = [
  { icon: "🔒", title: "Yours alone", body: "End-to-end encrypted — not even our servers can read it." },
  { icon: "🎙️", title: "Crystal voice", body: "Studio-grade audio. Hop into a call in one tap." },
  { icon: "🖥️", title: "Share your screen", body: "Up to 4K, 60fps — free, no catch." },
];

/**
 * First-run welcome. Turns the empty-app cliff into one obvious action:
 * name your space and you're instantly inside a live channel.
 */
export function Onboarding({ displayName, onCreate, onSkip, onPickAccent }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accent, setAccentSel] = useState<string>(getActiveAccent);
  const inputRef = useRef<HTMLInputElement>(null);

  function pickAccent(hex: string) {
    setAccentSel(hex);
    onPickAccent?.(hex); // applies live (recolors this screen) + syncs
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const firstName = (displayName || "there").split(/\s+/)[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set that up — try again.");
      setBusy(false);
    }
  }

  return (
    <div
      className="flex h-screen w-screen items-center justify-center overflow-y-auto"
      style={{
        background:
          "radial-gradient(circle at 28% 18%, color-mix(in oklch, var(--accent) 16%, var(--bg-base)) 0%, var(--bg-base) 58%)",
        padding: "var(--space-6)",
      }}
    >
      <div className="kc-fade-up flex w-full max-w-xl flex-col items-center text-center">
        <div className="kc-float mb-1" style={{ color: "var(--accent)" }}>
          <BirdMark size={64} />
        </div>

        <h1
          style={{
            fontFamily: "var(--font-display)", fontWeight: 700,
            fontSize: "var(--text-3xl)", color: "var(--text-primary)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          oh, hi {firstName} 👋
        </h1>
        <p className="mt-2 text-base" style={{ color: "var(--text-secondary)", maxWidth: 440 }}>
          Your place to talk, hang out, and share — free forever, and private by design:
          we genuinely can't read a word. Let's make your first space — about three seconds.
        </p>

        {/* Create-your-first-space card */}
        <div
          className="kc-card mt-7 w-full"
          style={{
            background: "var(--bg-channel)",
            borderRadius: "var(--radius-xl)",
            boxShadow: "var(--shadow-lg)",
            padding: "var(--space-6)",
            border: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)",
          }}
        >
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label
              htmlFor="kc-space-name"
              className="text-left text-xs font-bold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}
            >
              Name your space
            </label>
            <div className="flex gap-2">
              <input
                id="kc-space-name"
                ref={inputRef}
                className="kc-field flex-1 px-3.5 py-3 text-sm outline-none"
                placeholder="The Roost"
                value={name}
                maxLength={64}
                onChange={(e) => { setName(e.target.value); if (error) setError(""); }}
              />
              <button
                type="submit"
                disabled={!trimmed || busy}
                className="kc-cta flex flex-shrink-0 items-center justify-center gap-2 px-5 py-3 text-sm"
                style={{ opacity: !trimmed || busy ? 0.65 : 1, cursor: !trimmed || busy ? "default" : "pointer" }}
              >
                {busy ? (
                  <span className="kc-spinner" style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }} />
                ) : (
                  "Let's go →"
                )}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setName(s); inputRef.current?.focus(); }}
                  className="kc-interactive px-2.5 py-1 text-xs font-semibold"
                  style={{
                    borderRadius: "var(--radius-full)",
                    background: "var(--bg-input)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            {error && (
              <div
                role="alert"
                className="kc-shake px-3 py-2 text-left text-xs"
                style={{
                  background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                  color: "var(--danger)", borderRadius: "var(--radius-md)", fontWeight: 500,
                }}
              >
                {error}
              </div>
            )}
          </form>
        </div>

        {/* Make it yours — pick an accent right away (recolors this screen live) */}
        {onPickAccent && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <span className="text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
              Make it yours
            </span>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              {ACCENT_PRESETS.map((p) => {
                const isActive = accent.toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    title={p.name}
                    aria-label={`Accent ${p.name}`}
                    aria-pressed={isActive}
                    onClick={() => pickAccent(p.hex)}
                    className="kc-accent-swatch"
                    style={{
                      background: p.hex,
                      boxShadow: isActive ? `0 0 0 2px var(--bg-base), 0 0 0 4px ${p.hex}` : undefined,
                    }}
                  >
                    {isActive && (
                      <span aria-hidden="true" style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>✓</span>
                    )}
                  </button>
                );
              })}
            </div>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              You can fine-tune everything later in Settings → Appearance.
            </span>
          </div>
        )}

        {/* Value bullets */}
        <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          {VALUE_BULLETS.map((b) => (
            <div
              key={b.title}
              className="flex flex-col items-center gap-1 px-3 py-3"
              style={{ borderRadius: "var(--radius-lg)", background: "color-mix(in oklch, var(--bg-channel) 55%, transparent)" }}
            >
              <span className="text-xl" aria-hidden>{b.icon}</span>
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{b.title}</span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>{b.body}</span>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="kc-interactive mt-5 text-sm font-semibold"
          style={{ color: "var(--text-muted)", background: "none", border: "none" }}
        >
          I'll look around first
        </button>
      </div>
    </div>
  );
}
