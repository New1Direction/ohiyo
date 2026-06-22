import { useCallback, useEffect, useState } from "react";
import { api, type EventInfo } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  currentUserId: string;
  /** Bumped when a gateway EventsChanged arrives for this server. */
  refreshKey: number;
  onClose: () => void;
};

/** Plan and RSVP to server hangouts. */
export function EventsModal({ token, serverId, currentUserId, refreshKey, onClose }: Props) {
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [title, setTitle] = useState("");
  // Seed the next round hour so the input never shows the empty "yyyy-mm-dd" mask.
  const [when, setWhen] = useState(() => nextRoundHourLocal());
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setEvents(await api.listEvents(token, serverId));
    } catch {
      setEvents([]);
      setError("Events could not load. Check your connection and try again.");
    }
  }, [token, serverId]);

  // Re-fetch on a gateway EventsChanged bump, and when the token/server changes
  // (e.g. a token rotation while the modal is open).
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const ts = when ? Math.floor(new Date(when).getTime() / 1000) : 0;
    if (!title.trim() || !ts || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createEvent(token, serverId, title.trim(), ts, desc.trim() || null);
      setTitle("");
      setWhen(nextRoundHourLocal());
      setDesc("");
      await refresh();
    } catch {
      setError("Could not create that event. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function rsvp(id: string) {
    try {
      setError(null);
      await api.rsvpEvent(token, serverId, id);
      await refresh();
    } catch {
      setError("Could not update your RSVP. Try again.");
    }
  }
  async function remove(id: string) {
    try {
      setError(null);
      await api.deleteEvent(token, serverId, id);
      await refresh();
    } catch {
      setError("Could not cancel that event. Try again.");
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-events-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-events-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        📅 Events
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Plan a hangout — everyone can RSVP.
      </p>

      {/* Create */}
      <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's happening? (e.g. Movie night)"
          aria-label="Event title"
          maxLength={120}
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />
        <span className="text-xs" style={{ color: "var(--text-secondary)", marginBottom: "calc(-1 * var(--space-1))" }}>
          When?
        </span>
        <div className="flex gap-2">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label="Event time"
            className="kc-field flex-1 px-3 py-2 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!title.trim() || !when || busy}
            className="kc-cta flex-shrink-0 px-4 py-2 text-sm"
            style={{ opacity: !title.trim() || !when || busy ? 0.65 : 1 }}
          >
            Add event
          </button>
        </div>
        {title.trim() && !when && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Add a time to schedule it.
          </p>
        )}
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Details (optional)"
          aria-label="Event details"
          maxLength={300}
          className="kc-field w-full px-3 py-2 text-sm outline-none"
        />
      </form>

      {error && (
        <div role="alert" className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-elevated))", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* List */}
      <div className="mt-5 flex flex-col gap-2" style={{ maxHeight: 340, overflowY: "auto" }}>
        {events.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--text-muted)", padding: "var(--space-4)" }}>
            Nothing planned yet. Start something above.
          </p>
        ) : (
          events.map((ev) => (
            <div
              key={ev.id}
              className="flex items-center gap-3 px-3 py-2.5"
              style={{ borderRadius: "var(--radius-lg)", background: "var(--bg-input)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{ev.title}</div>
                <div className="text-xs" style={{ color: "var(--accent)" }}>{fmtWhen(ev.starts_at)}</div>
                {ev.description && (
                  <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{ev.description}</div>
                )}
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {ev.rsvp_count} {ev.rsvp_count === 1 ? "person" : "people"} going
                </div>
              </div>
              <button
                type="button"
                onClick={() => rsvp(ev.id)}
                className="kc-interactive flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold"
                style={
                  ev.me_rsvp
                    ? { background: "var(--green)", color: "#fff", border: "none" }
                    : { background: "transparent", color: "var(--accent)", border: "1px solid var(--accent)" }
                }
              >
                {ev.me_rsvp ? "✓ Going" : "I'm in"}
              </button>
              {ev.created_by === currentUserId && (
                <button
                  type="button"
                  onClick={() => remove(ev.id)}
                  aria-label="Cancel event"
                  className="kc-interactive flex-shrink-0"
                  style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                >
                  ✕
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
}

function fmtWhen(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Next round hour from now, formatted for a datetime-local input (YYYY-MM-DDTHH:mm). */
function nextRoundHourLocal(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
