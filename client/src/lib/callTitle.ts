// The heading over the people in a call: a voice channel lists "People in General", a DM
// call is "Call with Bea", and a group chat's call is "Call in Pizza club".

export type CallKind = "voice" | "dm" | "group";

export function callHeading(kind: CallKind, name: string | null | undefined): { kicker: string; title: string } {
  const named = name?.trim() || null;
  switch (kind) {
    case "dm":
      return { kicker: "Call", title: named ? `Call with ${named}` : "Call" };
    case "group":
      return { kicker: "Group call", title: named ? `Call in ${named}` : "Group call" };
    default:
      return { kicker: "Voice room", title: `People in ${named ?? "Voice"}` };
  }
}
