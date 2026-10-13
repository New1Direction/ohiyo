// The card that rings when someone calls you in a DM or group chat. (Stub.)
import type { IncomingRing } from "../lib/dmCall";

export type IncomingCallCardProps = {
  ring: IncomingRing;
  onAccept: (video: boolean) => void;
  onDecline: () => void;
};

export function IncomingCallCard(_props: IncomingCallCardProps) {
  return null;
}
