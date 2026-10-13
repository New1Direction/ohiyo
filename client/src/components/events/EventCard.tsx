import type { EventInfo, EventRsvpStatus } from "../../api";
import { avatarStyle } from "../../lib/avatarStyle";
import { formatWhen } from "../../lib/eventCalendar";
import "./events.css";

type ChannelRef = { id: string; name: string; channel_type: string };

type Props = {
  event: EventInfo;
  /** The space's channels, to name a channel location. */
  channels: ChannelRef[];
  /** The host, or someone who can manage the space: they edit and cancel. */
  canManage: boolean;
  onRsvp: (status: EventRsvpStatus | null) => void;
  onJoinVoice: (channelId: string) => void;
  onAddToCalendar: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onDelete: () => void;
};

const ANSWERS: { status: EventRsvpStatus; label: string; count: (e: EventInfo) => number | null }[] = [
  { status: "interested", label: "Interested", count: (e) => e.counts.interested },
  { status: "going", label: "Going", count: (e) => e.counts.going },
  { status: "not_going", label: "Can't go", count: () => null },
];

/** One event: cover, time, place, details, your answer, who's going and what you can do. */
export function EventCard({ event, channels, canManage, onRsvp, onJoinVoice, onAddToCalendar, onEdit, onCancel, onDelete }: Props) {
  const channel = event.location?.channel_id ? channels.find((c) => c.id === event.location?.channel_id) : undefined;
  return (
    <article aria-label={event.title} className={`kc-event-card${event.cancelled ? " is-cancelled" : ""}`}>
      {event.cover_url && <img className="kc-event-cover" src={event.cover_url} alt="" loading="lazy" />}
      <div className="kc-event-body">
        <p className="kc-event-when">
          {event.cancelled && <span className="kc-event-flag">Cancelled</span>}
          <time dateTime={new Date(event.starts_at * 1000).toISOString()}>{formatWhen(event.starts_at, event.ends_at)}</time>
        </p>
        <h3 className="kc-event-title">{event.title}</h3>
        <Location event={event} channel={channel} onJoinVoice={onJoinVoice} />
        {event.description && <p className="kc-event-desc">{event.description}</p>}

        {!event.cancelled && (
          <div className="kc-event-answers" role="group" aria-label="Your answer">
            {ANSWERS.map((a) => {
              const mine = event.me_status === a.status;
              const count = a.count(event);
              return (
                <button
                  key={a.status}
                  type="button"
                  aria-pressed={mine}
                  className={`kc-event-answer kc-interactive is-${a.status}`}
                  onClick={() => onRsvp(mine ? null : a.status)}
                >
                  {a.label}
                  {count !== null && <span className="kc-event-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        <Going event={event} />

        <div className="kc-event-actions">
          <button type="button" className="kc-event-action kc-interactive" onClick={onAddToCalendar}>Add to calendar</button>
          {canManage && !event.cancelled && (
            <>
              <button type="button" className="kc-event-action kc-interactive" onClick={onEdit}>Edit</button>
              <button type="button" className="kc-event-action is-danger kc-interactive" onClick={onCancel}>Cancel event</button>
            </>
          )}
          {canManage && event.cancelled && (
            <button type="button" className="kc-event-action is-danger kc-interactive" onClick={onDelete}>Delete</button>
          )}
        </div>
      </div>
    </article>
  );
}

function Location({ event, channel, onJoinVoice }: { event: EventInfo; channel: ChannelRef | undefined; onJoinVoice: (id: string) => void }) {
  const loc = event.location;
  if (!loc) return null;
  if (loc.kind === "place") {
    const text = loc.text ?? "";
    const link = /^https?:\/\//i.test(text);
    return (
      <p className="kc-event-where">
        <span aria-hidden="true">📍 </span>
        {link ? (
          <a href={text} target="_blank" rel="noopener noreferrer nofollow">{text}</a>
        ) : (
          text
        )}
      </p>
    );
  }
  const name = channel?.name ?? "a channel that's gone";
  return (
    <p className="kc-event-where">
      <span aria-hidden="true">{loc.kind === "voice" ? "🔊 " : "# "}</span>
      {name}
      {loc.kind === "voice" && channel && !event.cancelled && (
        <button type="button" className="kc-event-join kc-interactive" onClick={() => onJoinVoice(channel.id)}>Join voice</button>
      )}
    </p>
  );
}

/** Faces of who's going and a sentence naming them. */
function Going({ event }: { event: EventInfo }) {
  const people = event.going;
  if (people.length === 0) return null;
  const names = people.slice(0, 2).map((p) => p.display_name || p.username);
  const others = event.counts.going - names.length;
  const sentence =
    others > 0
      ? `${names.join(", ")} and ${others} ${others === 1 ? "other" : "others"} ${event.cancelled ? "were" : "are"} going`
      : `${names.join(" and ")} ${names.length === 1 ? (event.cancelled ? "was" : "is") : event.cancelled ? "were" : "are"} going`;
  return (
    <div className="kc-event-going">
      <ul className="kc-event-faces" aria-hidden="true">
        {people.map((p) => (
          <li key={p.id} className="kc-event-face" style={avatarStyle(p.id, p.avatar_url)} title={p.display_name || p.username} />
        ))}
      </ul>
      <span>{sentence}</span>
    </div>
  );
}
