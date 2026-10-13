import type { EventReminder } from "../../gateway";
import { formatTime } from "../../lib/eventCalendar";
import "./events.css";

type Props = {
  reminder: EventReminder;
  onJoinVoice: (channelId: string) => void;
  onOpen: () => void;
  onDismiss: () => void;
};

const KICKER: Record<EventReminder["phase"], string> = {
  soon: "Starting soon",
  start: "Event starting",
  cancelled: "Event cancelled",
};

/** The reminder across the top: an event you're in starts soon, is starting, or is off. */
export function EventBanner({ reminder, onJoinVoice, onOpen, onDismiss }: Props) {
  const voiceChannel = reminder.phase !== "cancelled" && reminder.location_kind === "voice" ? reminder.location_channel_id : null;
  return (
    <div role="status" className={`kc-event-banner is-${reminder.phase}`}>
      <span className="kc-event-banner-kicker">{KICKER[reminder.phase]}</span>
      <button type="button" className="kc-event-banner-title kc-interactive" onClick={onOpen}>
        {reminder.title}
      </button>
      <span className="kc-event-banner-time">{formatTime(reminder.starts_at)}</span>
      {voiceChannel && (
        <button type="button" className="kc-event-banner-join kc-interactive" onClick={() => onJoinVoice(voiceChannel)}>
          Join voice
        </button>
      )}
      <button type="button" className="kc-event-banner-close kc-interactive" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
