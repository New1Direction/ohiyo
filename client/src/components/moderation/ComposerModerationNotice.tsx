import { Icon } from "../Icon";
import { durationLabel, slowmodeWait, timeoutNotice } from "../../lib/moderation";
import { useNow } from "./useModerationClock";
import "./moderation.css";

/** "every 10 seconds", "every minute", "every hour". */
function every(seconds: number) {
  const label = durationLabel(seconds);
  return label.startsWith("1 ") ? label.slice(2) : label;
}

/** What the composer area says while you're timed out (in place of the box you type in)
 *  or the channel is in slowmode (above it, counting down after you post). A live region,
 *  so a screen reader hears it change; empty when there is nothing to say. */
export function ComposerModerationNotice({
  timedOutUntil,
  slowmodeSeconds,
  lastSentAt,
  now,
  locale,
}: {
  /** When your time out ends (unix seconds), or null. */
  timedOutUntil: number | null;
  slowmodeSeconds: number;
  /** When you last posted here (ms), for the countdown. */
  lastSentAt: number | null;
  /** The time to show it at (tests pin it); otherwise it ticks by itself. */
  now?: number;
  locale?: string;
}) {
  // Tick only while something counts down: a time out, or a wait after your last message.
  const counting = timedOutUntil != null || slowmodeWait(lastSentAt, slowmodeSeconds, Date.now()) > 0;
  const clock = useNow(now === undefined && counting);
  const at = now ?? clock;
  const timedOut = timedOutUntil != null ? timeoutNotice(timedOutUntil, at, locale) : null;

  if (timedOut) {
    return (
      <div role="status" className="kc-composer-mod" data-kind="timeout">
        <Icon name="clock" />
        <span>{timedOut}</span>
      </div>
    );
  }
  if (slowmodeSeconds <= 0) return <div role="status" className="kc-composer-mod" />;
  const wait = slowmodeWait(lastSentAt, slowmodeSeconds, at);
  return (
    <div role="status" className="kc-composer-mod" data-kind="slowmode">
      <Icon name="hourglass" size={16} />
      <span>Slowmode is on: one message every {every(slowmodeSeconds)}</span>
      {wait > 0 && <span className="kc-composer-mod__wait">You can post again in {wait}s</span>}
    </div>
  );
}
