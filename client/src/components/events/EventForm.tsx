import { useEffect, useMemo, useState } from "react";
import type { EventDraft, EventInfo } from "../../api";
import "./events.css";

type ChannelRef = { id: string; name: string; channel_type: string };

/** What the form hands back: the event, and a new cover picture to upload first. */
export type EventFormResult = { draft: EventDraft; cover: File | null; removeCover: boolean };

type Props = {
  channels: ChannelRef[];
  /** The event being edited; absent for a new one. */
  initial?: EventInfo;
  busy: boolean;
  onSubmit: (result: EventFormResult) => void;
};

const TITLE_MAX = 200;
const PLACE_MAX = 100;
const DETAILS_MAX = 4000;
const TWO_YEARS_SECS = 2 * 366 * 24 * 60 * 60;

const pad = (n: number) => String(n).padStart(2, "0");

/** Unix seconds as a datetime-local value, in local time. */
function toInput(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) as unix seconds, or null if it isn't one. */
function fromInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function nextRoundHour(): number {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Where, as one select value: "", "voice:<id>", "text:<id>" or "place". */
function whereOf(ev: EventInfo | undefined, channels: ChannelRef[]): string {
  if (!ev) {
    const voice = channels.find((c) => c.channel_type === "voice");
    return voice ? `voice:${voice.id}` : "";
  }
  const loc = ev.location;
  if (!loc) return "";
  if (loc.kind === "place") return "place";
  return loc.channel_id ? `${loc.kind}:${loc.channel_id}` : "";
}

/** Create or edit an event: name, start and end, place, cover and details. */
export function EventForm({ channels, initial, busy, onSubmit }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [starts, setStarts] = useState(toInput(initial?.starts_at ?? nextRoundHour()));
  const [ends, setEnds] = useState(initial?.ends_at ? toInput(initial.ends_at) : "");
  const [where, setWhere] = useState(() => whereOf(initial, channels));
  const [place, setPlace] = useState(initial?.location?.kind === "place" ? initial.location.text ?? "" : "");
  const [details, setDetails] = useState(initial?.description ?? "");
  const [cover, setCover] = useState<File | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const preview = useMemo(() => (cover ? URL.createObjectURL(cover) : null), [cover]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const shownCover = preview ?? (removeCover ? null : initial?.cover_url ?? null);
  const voice = channels.filter((c) => c.channel_type === "voice");
  const text = channels.filter((c) => c.channel_type === "text");

  function check(): EventDraft | string {
    const name = title.trim();
    if (!name) return "Give your event a name.";
    const startsAt = fromInput(starts);
    if (startsAt === null) return "Pick when it starts.";
    const now = Math.floor(Date.now() / 1000);
    const moved = !initial || startsAt !== initial.starts_at;
    if (moved && startsAt < now - 60) return "That time has already passed.";
    if (startsAt > now + TWO_YEARS_SECS) return "Events can be planned up to two years ahead.";
    const endsAt = fromInput(ends);
    if (endsAt !== null && endsAt <= startsAt) return "It has to end after it starts.";
    let location: EventDraft["location"] = null;
    if (where === "place") {
      const p = place.trim();
      if (!p) return "Say where it is, or pick a channel.";
      if (/:\/\//.test(p) && !/^https?:\/\//i.test(p)) return "A link has to start with http:// or https://.";
      location = { kind: "place", text: p };
    } else if (where) {
      const [kind, id] = where.split(":");
      location = { kind: kind as "voice" | "text", channel_id: id };
    }
    return { title: name, description: details.trim() || null, starts_at: startsAt, ends_at: endsAt, location };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const result = check();
    if (typeof result === "string") {
      setProblem(result);
      return;
    }
    setProblem(null);
    onSubmit({ draft: result, cover, removeCover });
  }

  return (
    <form className="kc-event-form" onSubmit={submit} aria-label={initial ? "Edit event" : "New event"}>
      <label className="kc-event-field">
        <span>Name</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's happening? (e.g. Movie night)"
          aria-label="Event title"
          maxLength={TITLE_MAX}
          className="kc-field"
          required
        />
      </label>
      <div className="kc-event-row">
        <label className="kc-event-field">
          <span>Starts</span>
          <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} aria-label="Starts" className="kc-field" required />
        </label>
        <label className="kc-event-field">
          <span>Ends <em>(optional)</em></span>
          <input type="datetime-local" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} aria-label="Ends" className="kc-field" />
        </label>
      </div>
      <label className="kc-event-field">
        <span>Where</span>
        <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Where" className="kc-field">
          <option value="">No place</option>
          {voice.length > 0 && (
            <optgroup label="Voice channels">
              {voice.map((c) => (
                <option key={c.id} value={`voice:${c.id}`}>🔊 {c.name}</option>
              ))}
            </optgroup>
          )}
          {text.length > 0 && (
            <optgroup label="Text channels">
              {text.map((c) => (
                <option key={c.id} value={`text:${c.id}`}># {c.name}</option>
              ))}
            </optgroup>
          )}
          <option value="place">Somewhere else…</option>
        </select>
      </label>
      {where === "place" && (
        <label className="kc-event-field">
          <span>Place or link</span>
          <input
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            placeholder="An address, a venue, or a https:// link"
            aria-label="Place or link"
            maxLength={PLACE_MAX}
            className="kc-field"
          />
        </label>
      )}
      <div className="kc-event-field">
        <span>Cover <em>(optional)</em></span>
        <div className="kc-event-cover-pick">
          {shownCover && <img src={shownCover} alt="" className="kc-event-cover-thumb" />}
          <label className="kc-event-action kc-interactive">
            {shownCover ? "Change picture" : "Add a picture"}
            <input
              type="file"
              accept="image/*"
              aria-label="Cover image"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setCover(file);
                if (file) setRemoveCover(false);
              }}
            />
          </label>
          {shownCover && (
            <button
              type="button"
              className="kc-event-action kc-interactive"
              onClick={() => {
                setCover(null);
                setRemoveCover(true);
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <label className="kc-event-field">
        <span>Details <em>(optional)</em></span>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          aria-label="Event details"
          maxLength={DETAILS_MAX}
          rows={3}
          className="kc-field"
        />
      </label>
      {problem && (
        <p role="alert" className="kc-event-problem">{problem}</p>
      )}
      <button type="submit" className="kc-cta kc-event-submit" disabled={busy}>
        {initial ? "Save changes" : "Create event"}
      </button>
    </form>
  );
}
