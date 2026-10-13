import { useCallback, useEffect, useRef, useState } from "react";
import type { ModerationLogEntry } from "../../api";
import { MOD_ACTION_FILTERS, describeModAction } from "../../lib/moderation";
import { errorText } from "./errorText";
import "./moderation.css";

export type LogEntry = ModerationLogEntry;

type ListOptions = { action?: string; before?: number; beforeId?: string };

const DANGER = new Set(["ban_member", "kick_member", "timeout_member", "delete_message"]);
const CALM = new Set(["unban_member", "remove_timeout", "resume_invites"]);

const when = (at: number) =>
  new Date(at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Whom an entry was about, by name: a person, a channel, or nothing (the space itself). */
function targetLabel(entry: LogEntry, channelName?: (id: string) => string | undefined): string | null {
  if (entry.target_type === "user") return entry.target_name ?? "Deleted account";
  if (entry.target_type === "channel") {
    const name = channelName?.(entry.target_id);
    return name ? `#${name}` : "a channel";
  }
  if (entry.target_type === "message") return "a message";
  return null;
}

/** The space's moderation log, newest first: who did what to whom, why and when, by name.
 *  Filters by kind of action and loads older entries a page at a time. */
export function ModerationLog({
  api,
  pageSize = 50,
  channelName,
}: {
  api: { list: (opts: ListOptions) => Promise<LogEntry[]> };
  pageSize?: number;
  channelName?: (id: string) => string | undefined;
}) {
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may land: a slow page for an old filter is dropped.
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  const load = useCallback(
    async (opts: ListOptions, append: boolean) => {
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const page = await apiRef.current.list(opts);
        if (mine !== generation.current) return;
        setEntries((rows) => (append ? [...(rows ?? []), ...page] : page));
        setHasMore(page.length >= pageSize);
      } catch (err) {
        if (mine === generation.current) setError(errorText(err, "Couldn't load the moderation log."));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [pageSize],
  );

  useEffect(() => {
    void load({ action: filter || undefined }, false);
  }, [filter, load]);

  const last = entries && entries.length > 0 ? entries[entries.length - 1] : undefined;

  return (
    <section aria-label="Moderation log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="kc-mod-legend" style={{ margin: 0 }}>
          Moderation log
        </h3>
        <select
          aria-label="Filter actions"
          className="kc-field px-3 py-1.5 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All actions</option>
          {MOD_ACTION_FILTERS.map((f) => (
            <option key={f.action} value={f.action}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="kc-mod-error">
          {error}
        </p>
      )}
      {entries === null ? (
        !error && <div className="kc-skeleton mt-3" style={{ height: 64 }} aria-hidden="true" />
      ) : entries.length === 0 ? (
        <p className="kc-mod-empty">{filter ? "Nothing like that yet." : "Nothing has happened yet."}</p>
      ) : (
        <ol className="kc-mod-list" aria-label="Moderation actions">
          {entries.map((entry) => {
            const target = targetLabel(entry, channelName);
            const tone = DANGER.has(entry.action) ? "danger" : CALM.has(entry.action) ? "calm" : undefined;
            return (
              <li key={entry.id} className="kc-mod-row">
                <span className="kc-mod-initial" aria-hidden="true">
                  {((entry.actor_name ?? "?")[0] ?? "?").toUpperCase()}
                </span>
                <div className="kc-mod-row__body">
                  <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    <span className="kc-mod-row__name" style={entry.actor_name ? undefined : { color: "var(--text-muted)", fontStyle: "italic" }}>
                      {entry.actor_name ?? "Deleted account"}
                    </span>{" "}
                    <span className="kc-mod-action" data-tone={tone}>
                      {describeModAction(entry)}
                    </span>
                    {target && (
                      <>
                        {" · "}
                        <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{target}</span>
                      </>
                    )}
                  </div>
                  <div className="kc-mod-row__meta">
                    <time dateTime={new Date(entry.created_at * 1000).toISOString()}>{when(entry.created_at)}</time>
                  </div>
                  {entry.reason && <p className="kc-mod-row__reason">{entry.reason}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {hasMore && last && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load({ action: filter || undefined, before: last.created_at, beforeId: last.id }, true)}
            className="kc-interactive kc-polish-button kc-mod-button kc-mod-button--small"
          >
            Load more
          </button>
        </div>
      )}
    </section>
  );
}
