// Which link previews a message may show. A preview leaks: the client-side card sends
// the URL to the server's /og endpoint, and preview images / YouTube iframes load from
// the linked host (exposing the reader's IP). So a message decrypted on this device, or
// any message in a chat in encrypted mode, gets none — its links stay plain, clickable
// links. Pure, for unit tests.
import type { Message } from "../api";

export type LinkPreviewMode =
  | "none" // no preview of any kind
  | "server-embeds" // render the embeds the server attached (no client fetch)
  | "client-fetch"; // fetch a preview for each link in the text

export function linkPreviewMode(
  message: Pick<Message, "_encrypted" | "embeds">,
  channelEncrypted: boolean,
): LinkPreviewMode {
  if (message._encrypted || channelEncrypted) return "none";
  return message.embeds?.length ? "server-embeds" : "client-fetch";
}
