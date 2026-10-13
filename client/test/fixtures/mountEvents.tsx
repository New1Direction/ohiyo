import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import type { EventInfo } from "../../src/api";
import { EventCalendar } from "../../src/components/events/EventCalendar";
import { EventCard } from "../../src/components/events/EventCard";
import { EventBanner } from "../../src/components/events/EventBanner";
export { act };

const bea = { id: "b", username: "bea", display_name: "Bea", avatar_url: null };
const channels = [
  { id: "c1", name: "general", channel_type: "text" },
  { id: "c2", name: "General", channel_type: "voice" },
];

function event(over: Partial<EventInfo>): EventInfo {
  return {
    id: "ev",
    server_id: "s1",
    title: "Event",
    description: null,
    starts_at: 0,
    ends_at: null,
    created_by: "a",
    rsvp_count: 0,
    me_rsvp: false,
    location: null,
    cover_url: null,
    cancelled: false,
    counts: { interested: 0, going: 0, not_going: 0 },
    me_status: null,
    going: [],
    ...over,
  };
}

const NOON_12_OCT = Date.UTC(2026, 9, 12, 12, 0) / 1000;
const gameNight = event({
  id: "ev-game",
  title: "Game night",
  starts_at: Date.UTC(2026, 9, 20, 19, 0) / 1000,
  ends_at: Date.UTC(2026, 9, 20, 21, 0) / 1000,
  location: { kind: "voice", channel_id: "c2", text: null },
  counts: { interested: 2, going: 1, not_going: 0 },
  me_status: "interested",
  going: [bea],
  rsvp_count: 1,
});
const picnic = event({
  id: "ev-picnic",
  title: "Picnic",
  starts_at: NOON_12_OCT + 3 * 3600,
  location: { kind: "place", channel_id: null, text: "Dolores Park" },
});

function mount(element: HTMLElement, node: (record: (name: string) => () => void) => React.ReactNode) {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  const root = createRoot(element);
  act(() => root.render(node(record)));
  return { calls, unmount: () => act(() => root.unmount()) };
}

/** The calendar with two events this month: a picnic today and a game night next week. */
export function mountEventCalendar(element: HTMLElement, { now, view }: { now: number; view?: "month" | "agenda" }) {
  const calls: string[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <EventCalendar
        events={[gameNight, picnic]}
        now={now}
        defaultView={view ?? "month"}
        onOpen={(id) => calls.push(`open ${id}`)}
      />,
    ),
  );
  return { calls, unmount: () => act(() => root.unmount()) };
}

/** One event's card: a voice-channel game night, or the same night cancelled. */
export function mountEventCard(element: HTMLElement, { variant, canManage }: { variant: "voice" | "cancelled"; canManage: boolean }) {
  const ev = variant === "cancelled" ? { ...gameNight, cancelled: true } : gameNight;
  const calls: string[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <EventCard
        event={ev}
        channels={channels}
        canManage={canManage}
        onRsvp={(status) => calls.push(`rsvp ${status ?? "none"}`)}
        onJoinVoice={(id) => calls.push(`join ${id}`)}
        onAddToCalendar={() => calls.push("ics")}
        onEdit={() => calls.push("edit")}
        onCancel={() => calls.push("cancel")}
        onDelete={() => calls.push("delete")}
      />,
    ),
  );
  return { calls, unmount: () => act(() => root.unmount()) };
}

/** The reminder banner for game night, in a voice channel or a place. */
export function mountEventBanner(element: HTMLElement, { phase, voice }: { phase: "soon" | "start" | "cancelled"; voice: boolean }) {
  return mount(element, (record) => (
    <EventBanner
      reminder={{
        server_id: "s1",
        event_id: "ev-game",
        title: "Game night",
        starts_at: gameNight.starts_at,
        phase,
        location_kind: voice ? "voice" : "place",
        location_channel_id: voice ? "c2" : null,
      }}
      onJoinVoice={(id) => record(`join ${id}`)()}
      onOpen={record("open")}
      onDismiss={record("dismiss")}
    />
  ));
}
