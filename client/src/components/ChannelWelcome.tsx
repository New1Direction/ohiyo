import { useEffect, useState } from "react";
import { BirdMark } from "./BirdMark";

/**
 * The empty-channel state. Always greets the channel; the FIRST time a brand-new
 * account lands in an empty channel it also unfolds the full Ohiyo welcome — a
 * thank-you, what we believe, and a nudge to spread the vibe. Shown once, ever.
 */

// Per-account so a different login on a shared device still gets the welcome.
const seenKey = (userId?: string) => `kc:welcome-manifesto-seen:${userId ?? "anon"}`;
const recoveryNudgeKey = (userId?: string) => `kc:recovery-nudge-seen:${userId ?? "anon"}`;

const SHARE_NOTE =
  "I just switched to Ohiyo 🐿️ — a free, open chat with real end-to-end encryption and " +
  "nothing to sell you. No ads, no tracking, no paywall. Come hang out: https://github.com/New1Direction/ohiyo";

type Props = {
  /** The channel name (server text channels). Ignored for DMs. */
  channelName?: string;
  /** A DM or group DM, so we greet a conversation instead of a #channel. */
  isDM?: boolean;
  /** Current user id, so the one-time manifesto is per-account, not per-device. */
  userId?: string;
  /** Opens Settings → Backup & recovery; when present, a one-time recovery-code nudge shows. */
  onSaveRecovery?: () => void;
};

export function ChannelWelcome({ channelName, isDM, userId, onSaveRecovery }: Props) {
  // Full manifesto only the first time THIS account sees an empty channel.
  const [showManifesto] = useState(() => {
    try {
      return localStorage.getItem(seenKey(userId)) === null;
    } catch {
      return false;
    }
  });
  const [copied, setCopied] = useState(false);
  // One-time, dismissible recovery-code nudge (per account).
  const [showRecovery, setShowRecovery] = useState(() => {
    try {
      return localStorage.getItem(recoveryNudgeKey(userId)) === null;
    } catch {
      return false;
    }
  });
  function dismissRecovery() {
    setShowRecovery(false);
    try {
      localStorage.setItem(recoveryNudgeKey(userId), "1");
    } catch {
      /* storage off — non-fatal */
    }
  }

  useEffect(() => {
    if (showManifesto) {
      try {
        localStorage.setItem(seenKey(userId), "1");
      } catch {
        /* storage off — non-fatal */
      }
    }
  }, [showManifesto, userId]);

  const title = isDM ? "Say hi 👋" : channelName ? `Welcome to #${channelName}!` : "This channel's all quiet";
  const sub = isDM
    ? "The very beginning of your conversation — end-to-end encrypted, so only the two of you can ever read it."
    : channelName
      ? `This is the start of the #${channelName} channel — say something to kick it off.`
      : "Say something — it's a great place to start.";

  async function copyShare() {
    try {
      await navigator.clipboard.writeText(SHARE_NOTE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 overflow-y-auto text-center"
      style={{ color: "var(--text-muted)", padding: "var(--space-6)" }}
    >
      <div style={{ color: "var(--accent)", opacity: 0.9, marginBottom: "var(--space-1)" }}>
        <BirdMark size={72} />
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "var(--text-xl)",
          color: "var(--text-primary)",
        }}
      >
        {title}
      </div>
      <div className="text-sm" style={{ maxWidth: "46ch" }}>
        {sub}
      </div>

      {showManifesto && (
        <div
          className="kc-welcome-card mt-5 text-left"
          style={{
            maxWidth: "var(--welcome-w, 540px)",
            width: "100%",
            background: "var(--bg-sidebar)",
            border: "1px solid var(--bg-hover)",
            borderRadius: "var(--radius-xl, 18px)",
            padding: "1.4rem 1.5rem",
            boxShadow: "var(--shadow-lg, 0 18px 40px -18px rgba(0,0,0,0.25))",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: "1.25rem",
              color: "var(--text-primary)",
              marginBottom: "0.6rem",
            }}
          >
            🐿️ Welcome to Ohiyo.
          </div>
          <div className="space-y-3 text-sm" style={{ color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <p>
              <strong style={{ color: "var(--text-primary)" }}>Your messages are end-to-end encrypted.</strong> Not
              &ldquo;trust us&rdquo; encrypted — we genuinely can&apos;t read them, and we built it that way on purpose.
            </p>
            <p>
              <strong style={{ color: "var(--text-primary)" }}>No ads, no tracking, no paywall.</strong> We build the
              thing and get out of your way.
            </p>
            <p style={{ color: "var(--text-primary)", fontWeight: 600 }}>
              If it lands, tell a friend. Chinchillin&apos; rest of your day. 🐿️💛
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyShare}
              className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}
            >
              {copied ? "Copied — go spread the vibe! 🎉" : "📣 Tell a friend"}
            </button>
            <a
              href="https://github.com/New1Direction/ohiyo"
              target="_blank"
              rel="noopener noreferrer"
              className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
              style={{ color: "var(--accent)", border: "1px solid var(--accent)", textDecoration: "none" }}
            >
              See what&apos;s new →
            </a>
          </div>
        </div>
      )}

      {onSaveRecovery && showRecovery && (
        <div
          className="mt-4 text-left"
          style={{
            maxWidth: "var(--welcome-w, 540px)",
            width: "100%",
            background: "color-mix(in oklch, var(--accent) 8%, var(--bg-sidebar))",
            border: "1px solid color-mix(in oklch, var(--accent) 28%, transparent)",
            borderRadius: "var(--radius-xl, 18px)",
            padding: "1.1rem 1.25rem",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: "1.05rem",
              color: "var(--text-primary)",
              marginBottom: "0.35rem",
            }}
          >
            🔑 One quick thing — save a recovery code
          </div>
          <p className="text-sm" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Because only you hold your keys, a recovery code is how you get your messages back on a new
            device if you ever lose this one. Takes about ten seconds.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onSaveRecovery();
                dismissRecovery();
              }}
              className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}
            >
              Save a recovery code
            </button>
            <button
              type="button"
              onClick={dismissRecovery}
              className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer" }}
            >
              Maybe later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
