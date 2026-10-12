// Someone deleted their account: the people they talked with see it at once (UserDeleted)
// or, after a reload, from Ready, which names every 1:1 chat's other person (dm_peers)
// and so leaves out the ones whose person is gone.
import type { Channel, Message, PublicUser } from "../api";

/** Who a 1:1 chat is with once that account is gone. */
export const GONE_PEER: PublicUser = { id: "", username: "", display_name: "Deleted account", avatar_url: null };

/** The 1:1 chats Ready names nobody for: their other person deleted their account. */
export function dmsWithNoPeer(dms: readonly Channel[], dmPeers: Readonly<Record<string, PublicUser>>): string[] {
  return dms.filter((d) => d.channel_type === "dm" && !(d.id in dmPeers)).map((d) => d.id);
}

/** The 1:1 chats that were with `userId`. */
export function dmsWith(peers: Readonly<Record<string, PublicUser>>, userId: string): string[] {
  return Object.entries(peers)
    .filter(([, peer]) => peer.id === userId)
    .map(([channelId]) => channelId);
}

/** What's on screen without `userId`'s messages. */
export function withoutAuthor(messages: readonly Message[], userId: string): Message[] {
  return messages.filter((m) => m.author.id !== userId);
}
