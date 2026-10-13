// A call's line in a DM or group chat: a phone with how the call went ("Call ended · 12m 03s",
// "Missed call from Ann"). Not a message you can reply to, edit or react to.
import { Icon } from "./Icon";
import type { CallLog } from "../lib/dmCall";

export function CallLogLine({ call, text }: { call: CallLog; text: string }) {
  const missed = call.state === "missed" || call.state === "declined";
  return (
    <div className={`kc-call-log${missed ? " is-missed" : ""}${call.state === "ringing" || call.state === "ongoing" ? " is-live" : ""}`}>
      <span className="kc-call-log-icon" aria-hidden="true">
        <Icon name={call.video ? "video" : missed ? "phoneOff" : "phone"} size={15} />
      </span>
      <span className="kc-call-log-text">{text}</span>
    </div>
  );
}
