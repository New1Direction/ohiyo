import { useEffect, useRef, useState, type PointerEvent } from "react";
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

const SUGGESTIONS = ["The Roost", "Study Room", "Game Night"];

const VALUE_BULLETS: { title: string; body: string }[] = [
  { title: "Private messages", body: "Encrypted chats for your space." },
  { title: "Voice calls", body: "Drop into a call when you need to talk." },
  { title: "Screen sharing", body: "Share what you’re working on." },
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
  const spotlightRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: 0, y: 0, frame: 0 });

  function pickAccent(hex: string) {
    setAccentSel(hex);
    onPickAccent?.(hex); // applies live (recolors this screen) + syncs
  }

  useEffect(() => {
    inputRef.current?.focus();
    const pointerState = pointerRef.current;
    return () => {
      if (pointerState.frame) window.cancelAnimationFrame(pointerState.frame);
    };
  }, []);

  const trimmed = name.trim();
  const firstName = (displayName || "there").split(/\s+/)[0];

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse") return;
    pointerRef.current.x = e.clientX;
    pointerRef.current.y = e.clientY;
    if (pointerRef.current.frame) return;
    pointerRef.current.frame = window.requestAnimationFrame(() => {
      pointerRef.current.frame = 0;
      const { x, y } = pointerRef.current;
      const spotlight = spotlightRef.current;
      if (spotlight) {
        spotlight.style.opacity = "1";
        spotlight.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      }
    });
  }

  function handlePointerLeave() {
    if (spotlightRef.current) spotlightRef.current.style.opacity = "0";
  }

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
      className="ohiyo-onboarding-screen relative flex h-screen w-screen items-center justify-center overflow-y-auto"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{
        background:
          "radial-gradient(circle at 28% 18%, color-mix(in oklch, var(--accent) 16%, var(--bg-base)) 0%, var(--bg-base) 58%)",
        padding: "var(--space-6)",
      }}
    >
      <div ref={spotlightRef} className="ohiyo-cursor-spotlight" aria-hidden="true" />
      <div className="ohiyo-onboarding-glow" aria-hidden="true" />
      <div className="ohiyo-onboarding-hero relative z-10 flex w-full max-w-xl flex-col items-center text-center">
        <div className="ohiyo-onboarding-mark mb-1" style={{ color: "var(--accent)" }}>
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
          Start with one private space. Invite people when you’re ready.
        </p>

        {/* Create-your-first-space card */}
        <div
          className="ohiyo-first-space-card kc-card mt-7 w-full"
          style={{
            background: "linear-gradient(145deg, color-mix(in oklch, var(--text-primary) 4%, var(--bg-channel)), var(--bg-channel))",
            borderRadius: "var(--radius-xl)",
            boxShadow: "var(--shadow-lg)",
            padding: "var(--space-6)",
            border: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)",
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
            <div className="flex flex-col gap-2 sm:flex-row">
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
                aria-busy={busy}
                className="kc-cta flex flex-shrink-0 items-center justify-center gap-2 px-5 py-3 text-sm"
                style={{ opacity: !trimmed || busy ? 0.65 : 1, cursor: !trimmed || busy ? "default" : "pointer", minWidth: 112 }}
              >
                {busy ? (
                  <span className="kc-spinner" style={{ width: 16, height: 16, borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }} />
                ) : trimmed ? (
                  "Let's go"
                ) : (
                  "Name it first"
                )}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>Suggestions</span>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setName(s); inputRef.current?.focus(); }}
                  className="ohiyo-suggestion-chip kc-interactive px-2.5 py-1 text-xs font-semibold"
                  style={{
                    borderRadius: "var(--radius-full)",
                    background: "color-mix(in oklch, var(--text-primary) 7%, var(--bg-input))",
                    color: "var(--text-secondary)",
                    border: "1px solid color-mix(in oklch, var(--text-primary) 7%, transparent)",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            <p className="ohiyo-space-preview text-left text-xs" aria-live="polite">
              {trimmed ? <>Creating <strong>{trimmed}</strong> — private by default.</> : "Private by default. You can change everything later."}
            </p>

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
          <div className="ohiyo-accent-section mt-6 flex flex-col items-center gap-2">
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
              You can change this later in Settings.
            </span>
          </div>
        )}

        {/* Concrete, no-hype setup notes */}
        <div className="ohiyo-setup-notes mt-6 w-full" aria-label="What Ohiyo includes">
          {VALUE_BULLETS.map((b) => (
            <div key={b.title} className="ohiyo-setup-note">
              <span className="ohiyo-setup-note-title">{b.title}</span>
              <span className="ohiyo-setup-note-body">{b.body}</span>
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
