import { BirdMark } from "./BirdMark";

/**
 * Shown in the main pane when a user has no servers and no DM open — e.g. after they
 * tap "I'll look around" on onboarding. Previously this was a blank 3-pane void with no
 * way forward; now it's an obvious next step.
 */
export function NoServersYet({
  onCreate,
  onFindPeople,
  onImportDiscord,
}: {
  onCreate: () => void;
  onFindPeople: () => void;
  onImportDiscord?: () => void;
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 text-center"
      style={{ color: "var(--text-muted)", padding: "var(--space-6)", background: "var(--bg-channel)" }}
    >
      <div style={{ color: "var(--accent)", opacity: 0.9 }}>
        <BirdMark size={84} />
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "var(--text-2xl, 1.6rem)",
          color: "var(--text-primary)",
        }}
      >
        Let&apos;s make this place yours 🦔
      </div>
      <div className="text-sm" style={{ maxWidth: "42ch" }}>
        Spin up a space for your group, or open a DM and say hi to a friend. Either way takes about ten
        seconds.
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="kc-interactive rounded-full px-5 py-2.5 text-sm font-semibold"
          style={{ background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}
        >
          ＋ Create a space
        </button>
        <button
          type="button"
          onClick={onFindPeople}
          className="kc-interactive rounded-full px-5 py-2.5 text-sm font-semibold"
          style={{ color: "var(--accent)", border: "1px solid var(--accent)", background: "transparent", cursor: "pointer" }}
        >
          Find people to DM
        </button>
        {onImportDiscord && (
          <button
            type="button"
            onClick={onImportDiscord}
            className="kc-interactive rounded-full px-5 py-2.5 text-sm font-semibold"
            style={{ color: "var(--text-secondary)", border: "1px solid var(--bg-input)", background: "var(--bg-input)", cursor: "pointer" }}
          >
            Import Discord
          </button>
        )}
      </div>
    </div>
  );
}
