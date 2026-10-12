import { ModalShell } from "./ModalShell";
import { Icon } from "./Icon";
import { threadChipLabel, type ThreadSummary } from "../lib/threads";

/** A channel's threads, the busiest first. Picking one opens it. */
export function ThreadListDialog({
  channelName,
  threads,
  onOpen,
  onClose,
}: {
  channelName: string;
  threads: readonly ThreadSummary[];
  onOpen: (thread: ThreadSummary) => void;
  onClose: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <ModalShell onClose={onClose} labelledBy="kc-thread-list-title" maxWidthClass="max-w-md">
      <h2 id="kc-thread-list-title" className="mb-1 text-xl font-bold" style={{ color: "var(--text-primary)" }}>
        Threads
      </h2>
      <p className="mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
        In #{channelName}
      </p>
      {threads.length === 0 ? (
        <p className="text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
          No threads yet. Start one from any message with the thread button.
        </p>
      ) : (
        <ul className="kc-thread-list">
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" className="kc-thread-list-item" onClick={() => onOpen(t)}>
                <Icon name="thread" size={18} />
                <span className="kc-thread-list-text">
                  <span className="kc-thread-list-name">{t.name}</span>
                  <span className="kc-thread-list-meta">{threadChipLabel(t.message_count, t.last_message_at, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  );
}
