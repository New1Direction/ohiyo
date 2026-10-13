import { ModalShell } from "./ModalShell";
import { Icon } from "./Icon";
import { splitThreads, threadChipLabel, type ThreadSummary } from "../lib/threads";

function ThreadRow({ thread, fresh, now, onOpen }: { thread: ThreadSummary; fresh: number; now: number; onOpen: () => void }) {
  const label = threadChipLabel(thread.message_count, thread.last_message_at, now);
  return (
    <li>
      <button
        type="button"
        className="kc-thread-list-item"
        aria-label={`${thread.name}: ${label}${fresh > 0 ? `, ${fresh} new` : ""}`}
        onClick={onOpen}
      >
        <Icon name="thread" size={18} />
        <span className="kc-thread-list-text">
          <span className="kc-thread-list-name">{thread.name}</span>
          <span className="kc-thread-list-meta">{label}</span>
        </span>
        {fresh > 0 && (
          <span className="kc-thread-chip-unread" aria-hidden="true">
            {fresh > 99 ? "99+" : fresh}
          </span>
        )}
      </button>
    </li>
  );
}

/** A channel's threads, the busiest first, with the ones nobody wrote in for a week under
 *  "Older". Followed threads show how many replies are new. Picking one opens it. */
export function ThreadListDialog({
  channelName,
  threads,
  unread,
  onOpen,
  onClose,
}: {
  channelName: string;
  threads: readonly ThreadSummary[];
  /** New replies in the threads you follow, by thread id. */
  unread?: ReadonlyMap<string, number>;
  onOpen: (thread: ThreadSummary) => void;
  onClose: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const { active, older } = splitThreads(threads, now);
  const row = (t: ThreadSummary) => (
    <ThreadRow key={t.id} thread={t} fresh={unread?.get(t.id) ?? 0} now={now} onOpen={() => onOpen(t)} />
  );
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
        <div className="kc-thread-list-scroll">
          {active.length > 0 && <ul className="kc-thread-list">{active.map(row)}</ul>}
          {older.length > 0 && (
            <section aria-labelledby="kc-thread-list-older" className="kc-thread-list-older">
              <h3 id="kc-thread-list-older" className="kc-thread-list-section">
                Older
              </h3>
              <p className="kc-thread-list-section-note">No replies for a week. A reply brings a thread back.</p>
              <ul className="kc-thread-list">{older.map(row)}</ul>
            </section>
          )}
        </div>
      )}
    </ModalShell>
  );
}
