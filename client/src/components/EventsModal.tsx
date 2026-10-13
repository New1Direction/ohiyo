import { useCallback, useEffect, useState } from "react";
import { api, getApiBase, getFileBase, type EventDraft, type EventInfo, type EventRsvpStatus } from "../api";
import { errorMessage } from "../lib/errorMessage";
import { eventToIcs, icsFileName } from "../lib/eventIcs";
import { fileUrlOn } from "../lib/fileUrl";
import { uploadOne } from "../lib/uploadOne";
import { EventCalendar, type CalendarView } from "./events/EventCalendar";
import { EventCard } from "./events/EventCard";
import { EventForm, type EventFormResult } from "./events/EventForm";
import { ModalShell } from "./ModalShell";

type ChannelRef = { id: string; name: string; channel_type: string };

type Props = {
  token: string;
  serverId: string;
  serverName: string;
  currentUserId: string;
  channels: ChannelRef[];
  /** They can manage the space, so they edit and cancel anyone's event. */
  canManageServer: boolean;
  /** Bumped when a gateway EventsChanged arrives for this server. */
  refreshKey: number;
  /** Open on this event's card (from a reminder). */
  initialEventId?: string | null;
  onJoinVoice: (channelId: string) => void;
  onClose: () => void;
};

type Screen = { kind: "calendar" } | { kind: "event"; id: string } | { kind: "form"; editing: EventInfo | null };

const PHONE_QUERY = "(max-width: 640px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return phone;
}

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Save an .ics file made here on the device. */
function downloadIcs(ev: EventInfo, location: string | null) {
  const ics = eventToIcs({ ...ev, location }, Math.floor(Date.now() / 1000));
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = icsFileName(ev.title);
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The space's events: a calendar, each event's card, and a form to plan or edit one. */
export function EventsModal(props: Props) {
  const { token, serverId, serverName, currentUserId, channels, canManageServer, refreshKey, initialEventId, onJoinVoice, onClose } = props;
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [screen, setScreen] = useState<Screen>(initialEventId ? { kind: "event", id: initialEventId } : { kind: "calendar" });
  const [chosenView, setChosenView] = useState<CalendarView | null>(null);
  const [day, setDay] = useState<string | undefined>(undefined);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = usePhone();
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      // Covers arrive as paths on the home's file server.
      const list = (await api.listEvents(token, serverId)).map((ev) =>
        ev.cover_url ? { ...ev, cover_url: fileUrlOn(getFileBase(), ev.cover_url) } : ev,
      );
      setEvents(list);
      return list;
    } catch {
      setError("Events could not load. Check your connection and try again.");
      return null;
    }
  }, [token, serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function run(what: string, action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(errorMessage(err, `Could not ${what}. Try again.`));
    }
  }

  async function save({ draft, cover, removeCover }: EventFormResult, editing: EventInfo | null) {
    setBusy(true);
    setError(null);
    try {
      const body: EventDraft = { ...draft };
      if (cover) body.cover_file_id = (await uploadOne(getApiBase(), token, cover)).id;
      else if (removeCover) body.cover_file_id = null;
      if (editing) await api.editEvent(token, serverId, editing.id, body);
      else await api.createEvent(token, serverId, body);
      const list = await refresh();
      const saved = editing
        ? list?.find((e) => e.id === editing.id)
        : list?.filter((e) => e.created_by === currentUserId && e.title === draft.title && e.starts_at === draft.starts_at).pop();
      setScreen(saved ? { kind: "event", id: saved.id } : { kind: "calendar" });
    } catch (err) {
      setError(errorMessage(err, "Could not save that event. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const open = screen.kind === "event" ? events.find((e) => e.id === screen.id) ?? null : null;
  const locationText = (ev: EventInfo): string | null => {
    const loc = ev.location;
    if (!loc) return `Ohiyo · ${serverName}`;
    if (loc.kind === "place") return loc.text;
    const ch = channels.find((c) => c.id === loc.channel_id);
    return `Ohiyo · ${serverName}${ch ? ` · ${loc.kind === "voice" ? "🔊" : "#"} ${ch.name}` : ""}`;
  };

  return (
    <ModalShell onClose={onClose} labelledBy="kc-events-title" maxWidthClass="max-w-2xl">
      <div className="kc-events-top">
        <h2 id="kc-events-title" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}>
          📅 Events
        </h2>
        {screen.kind === "calendar" && (
          <button type="button" className="kc-cta px-4 py-2 text-sm" onClick={() => setScreen({ kind: "form", editing: null })}>
            New event
          </button>
        )}
      </div>

      {screen.kind !== "calendar" && (
        <button
          type="button"
          className="kc-events-back"
          onClick={() => {
            setConfirmCancel(false);
            setError(null);
            setScreen(screen.kind === "form" && screen.editing ? { kind: "event", id: screen.editing.id } : { kind: "calendar" });
          }}
        >
          ‹ {screen.kind === "form" && screen.editing ? "Back to event" : "Back to calendar"}
        </button>
      )}

      {error && (
        <div role="alert" className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-input))", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      <div style={{ maxHeight: "min(70vh, 640px)", overflowY: "auto", marginTop: "var(--space-1)" }}>
        {screen.kind === "calendar" && (
          <EventCalendar
            events={events}
            now={now}
            view={chosenView ?? (phone ? "agenda" : "month")}
            onViewChange={setChosenView}
            day={day}
            onDayChange={setDay}
            onOpen={(id) => setScreen({ kind: "event", id })}
          />
        )}

        {screen.kind === "form" && (
          <EventForm channels={channels} initial={screen.editing ?? undefined} busy={busy} onSubmit={(r) => void save(r, screen.editing)} />
        )}

        {screen.kind === "event" && !open && <p className="kc-cal-empty">This event is gone.</p>}
        {open && (
          <>
            <EventCard
              event={open}
              channels={channels}
              canManage={open.created_by === currentUserId || canManageServer}
              onRsvp={(status: EventRsvpStatus | null) => void run("save your answer", () => api.rsvpEvent(token, serverId, open.id, status))}
              onJoinVoice={(id) => {
                onJoinVoice(id);
                onClose();
              }}
              onAddToCalendar={() => downloadIcs(open, locationText(open))}
              onEdit={() => setScreen({ kind: "form", editing: open })}
              onCancel={() => setConfirmCancel(true)}
              onDelete={() =>
                void run("delete that event", async () => {
                  await api.deleteEvent(token, serverId, open.id);
                  setScreen({ kind: "calendar" });
                })
              }
            />
            {confirmCancel && !open.cancelled && (
              <div className="kc-event-confirm" role="group" aria-label="Cancel this event?">
                <p>Cancel {open.title}? It stays on the calendar as cancelled, and everyone who answered is told.</p>
                <div className="kc-event-confirm-actions">
                  <button
                    type="button"
                    className="kc-event-action is-danger kc-interactive"
                    onClick={() =>
                      void run("cancel that event", async () => {
                        await api.cancelEvent(token, serverId, open.id);
                        setConfirmCancel(false);
                      })
                    }
                  >
                    Yes, cancel it
                  </button>
                  <button type="button" className="kc-event-action kc-interactive" onClick={() => setConfirmCancel(false)}>
                    Keep it
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
