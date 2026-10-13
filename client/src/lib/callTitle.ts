// The heading over the people in a call.

export type CallKind = "voice" | "dm" | "group";

export function callHeading(_kind: CallKind, name: string | null | undefined): { kicker: string; title: string } {
  return { kicker: "Voice room", title: `People in ${name}` };
}
