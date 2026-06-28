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

  const title = isDM ? "Start the private thread 👋" : channelName ? `Welcome to #${channelName}!` : "This channel's all quiet";
  const sub = isDM
    ? "Send the first encrypted message, drop a private file, or just say hi. The server only relays sealed envelopes."
    : channelName
      ? `This is the start of #${channelName}. Say hi, share a file, or hop into voice when text is too slow.`
      : "Say something, share a file, or start a call — it’s a great place to begin.";
  const suggestions = isDM
    ? ["Say hi", "Drop an encrypted file", "Verify safety number later"]
    : ["Say hi", "Share a file", "Start voice from the sidebar"];

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
      <div className="kc-empty-suggestions" aria-label="Suggested first actions">
        {suggestions.map((item) => <span key={item}>{item}</span>)}
      </div>

      {(showManifesto || (onSaveRecovery && showRecovery)) && (
        <div className="kc-setup-checklist mt-5 text-left">
          <div className="kc-setup-row is-done">
            <span className="kc-setup-step" aria-hidden>✓</span>
            <div className="min-w-0 flex-1">
              <div className="kc-setup-title">Space created</div>
              <div className="kc-setup-copy">Your first channel is ready.</div>
            </div>
          </div>

          {onSaveRecovery && showRecovery && (
            <div className="kc-setup-row is-active">
              <span className="kc-setup-step" aria-hidden>2</span>
              <div className="min-w-0 flex-1">
                <div className="kc-setup-title">Save a recovery code</div>
                <div className="kc-setup-copy">Use it to get back in on a new device.</div>
                <div className="kc-setup-actions">
                  <button
                    type="button"
                    onClick={() => {
                      onSaveRecovery();
                      dismissRecovery();
                    }}
                    className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
                    style={{ background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}
                  >
                    Save recovery code
                  </button>
                  <button
                    type="button"
                    onClick={dismissRecovery}
                    className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
                    style={{ background: "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer" }}
                  >
                    Later
                  </button>
                </div>
              </div>
            </div>
          )}

          {showManifesto && (
            <div className="kc-setup-row">
              <span className="kc-setup-step" aria-hidden>{onSaveRecovery && showRecovery ? "3" : "2"}</span>
              <div className="min-w-0 flex-1">
                <div className="kc-setup-title">Invite someone</div>
                <div className="kc-setup-copy">Bring one friend in when you’re ready.</div>
                <div className="kc-setup-actions">
                  <button
                    type="button"
                    onClick={copyShare}
                    className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
                    style={{ background: copied ? "color-mix(in oklch, var(--green) 22%, var(--bg-input))" : "var(--bg-input)", color: copied ? "var(--green)" : "var(--text-secondary)", border: "1px solid color-mix(in oklch, var(--text-primary) 7%, transparent)", cursor: "pointer" }}
                  >
                    {copied ? "Copied" : "Copy invite note"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
