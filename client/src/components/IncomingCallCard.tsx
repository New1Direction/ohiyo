// The card that rings when someone calls you in a DM or group chat, like Discord's: who is
// calling, whether it's a video call, and Accept / Accept with video / Decline. It sits above
// everything without taking focus from what you're typing; the buttons are a Tab away.
import { Icon } from "./Icon";
import type { IncomingRing } from "../lib/dmCall";

export type IncomingCallCardProps = {
  ring: IncomingRing;
  onAccept: (video: boolean) => void;
  onDecline: () => void;
};

export function IncomingCallCard({ ring, onAccept, onDecline }: IncomingCallCardProps) {
  const kind = ring.video ? "Video call" : "Voice call";
  return (
    <div
      className="kc-incoming-call"
      role="dialog"
      aria-modal="false"
      aria-label={`Incoming call from ${ring.callerName}`}
      aria-describedby={`kc-incoming-call-${ring.channelId}`}
    >
      <div className="kc-incoming-call-ring" aria-hidden="true">
        <Icon name={ring.video ? "video" : "phone"} size={22} />
      </div>
      <div className="kc-incoming-call-text" id={`kc-incoming-call-${ring.channelId}`} aria-live="assertive">
        <div className="kc-incoming-call-name">{ring.callerName} is calling</div>
        <div className="kc-incoming-call-kind">{kind}</div>
      </div>
      <div className="kc-incoming-call-actions">
        <button
          type="button"
          className="kc-incoming-call-btn kc-incoming-call-decline"
          aria-label="Decline"
          title="Decline"
          onClick={onDecline}
        >
          <Icon name="phoneOff" size={20} />
        </button>
        <button
          type="button"
          className="kc-incoming-call-btn kc-incoming-call-video"
          aria-label="Accept with video"
          title="Accept with video"
          onClick={() => onAccept(true)}
        >
          <Icon name="video" size={20} />
        </button>
        <button
          type="button"
          className="kc-incoming-call-btn kc-incoming-call-accept"
          aria-label="Accept"
          title="Accept"
          onClick={() => onAccept(false)}
        >
          <Icon name="phone" size={20} />
        </button>
      </div>
    </div>
  );
}
