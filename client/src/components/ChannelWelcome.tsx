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

type Props = {
  /** The channel name (server text channels). Ignored for DMs. */
  channelName?: string;
  /** A DM or group DM, so we greet a conversation instead of a #channel. */
  isDM?: boolean;
  /** The chat is in encrypted mode (its lock is on). Tapping the lock would turn it off. */
  encrypted?: boolean;
  /** Current user id, so the one-time manifesto is per-account, not per-device. */
  userId?: string;
  /** Opens Settings → Backup & recovery; when present, a one-time recovery-code nudge shows. */
  onSaveRecovery?: () => void;
  /** Opens this space's invite link. Only given for a channel in a space: a DM has no invite. */
  onInvite?: () => void;
};

export function ChannelWelcome({ channelName, isDM, encrypted, userId, onSaveRecovery, onInvite }: Props) {
  // Full manifesto only the first time THIS account sees an empty channel.
  const [showManifesto] = useState(() => {
    try {
      return localStorage.getItem(seenKey(userId)) === null;
    } catch {
      return false;
    }
  });
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
    ? encrypted
      ? "Send a message or drop a file. Encryption is on: the server stores only ciphertext for messages and files you send here."
      : "Send a message, drop a file, or tap the lock first to end-to-end encrypt this chat."
    : channelName
      ? `This is the start of #${channelName}. Say hi, share a file, or hop into voice when text is too slow.`
      : "Say something, share a file, or start a call — it’s a great place to begin.";
  const suggestions = isDM
    ? ["Say hi", encrypted ? "Encryption is on" : "Tap the lock to encrypt", "Verify safety number later"]
    : ["Say hi", "Share a file", "Start voice from the sidebar"];

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
              <div className="kc-setup-title">{isDM ? "Chat opened" : "You’re in"}</div>
              <div className="kc-setup-copy">{isDM ? "This chat is ready when you are." : "This channel is ready when you are."}</div>
            </div>
          </div>

          {onSaveRecovery && showRecovery && (
            <div className="kc-setup-row is-active">
              <span className="kc-setup-step" aria-hidden>2</span>
              <div className="min-w-0 flex-1">
                <div className="kc-setup-title">Save a recovery code</div>
                <div className="kc-setup-copy">It lets a new device read your encrypted messages. It doesn’t replace your password.</div>
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

          {/* A real invite to this space. It used to copy a note with a link to the project,
              which did not bring anyone into the space. */}
          {showManifesto && onInvite && !isDM && (
            <div className="kc-setup-row">
              <span className="kc-setup-step" aria-hidden>{onSaveRecovery && showRecovery ? "3" : "2"}</span>
              <div className="min-w-0 flex-1">
                <div className="kc-setup-title">Invite someone</div>
                <div className="kc-setup-copy">Bring one friend in when you’re ready.</div>
                <div className="kc-setup-actions">
                  <button
                    type="button"
                    onClick={onInvite}
                    className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
                    style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "1px solid color-mix(in oklch, var(--text-primary) 10%, transparent)" }}
                  >
                    Get an invite link
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
