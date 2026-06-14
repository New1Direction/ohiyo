import type { Poll } from "../api";

type Props = {
  poll: Poll;
  onVote: (optionId: string) => void;
};

/** Inline poll with live, animated result bars. Click an option to vote/unvote. */
export function PollWidget({ poll, onVote }: Props) {
  const closed = poll.closes_at != null && poll.closes_at * 1000 <= Date.now();
  const total = poll.total_votes;

  return (
    <div
      className="mt-1 w-full max-w-md"
      style={{
        border: "1px solid var(--bg-hover)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-3)",
        background: "color-mix(in oklch, var(--bg-channel) 60%, transparent)",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden>📊</span>
        <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{poll.question}</span>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {poll.options.map((o) => {
          const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
          return (
            <button
              key={o.id}
              type="button"
              disabled={closed}
              onClick={() => onVote(o.id)}
              aria-pressed={o.me}
              className="kc-interactive relative overflow-hidden text-left"
              style={{
                borderRadius: "var(--radius-md)",
                border: `1.5px solid ${o.me ? "var(--accent)" : "var(--bg-hover)"}`,
                background: "var(--bg-input)",
                padding: "7px 10px",
                cursor: closed ? "default" : "pointer",
              }}
            >
              {/* result fill */}
              <span
                aria-hidden
                style={{
                  position: "absolute", inset: 0, width: `${pct}%`,
                  background: o.me
                    ? "color-mix(in oklch, var(--accent) 22%, transparent)"
                    : "color-mix(in oklch, var(--text-muted) 16%, transparent)",
                  transition: "width var(--dur-slow) var(--ease-out)",
                }}
              />
              <span className="relative flex items-center justify-between gap-2 text-sm">
                <span className="truncate" style={{ color: "var(--text-primary)", fontWeight: o.me ? 600 : 400 }}>
                  {o.me ? "✓ " : ""}{o.text}
                </span>
                <span className="flex-shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
                  {pct}% · {o.votes}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        {total} {total === 1 ? "vote" : "votes"}
        {poll.multi ? " · pick multiple" : ""}
        {closed ? " · closed" : ""}
      </div>
    </div>
  );
}
