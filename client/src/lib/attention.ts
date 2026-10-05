// When a new message counts as seen. Pure, for unit tests.

export interface Attention {
  /** The chat that is open, if any. */
  openChannelId: string | null | undefined;
  /** The chat the message arrived in. */
  messageChannelId: string;
  /** The tab or page is in the background. */
  pageHidden: boolean;
  /** The desktop window is hidden in the tray. Always false in a browser. */
  windowHidden: boolean;
}

/** True only when the message's chat is open in a window the person can see. */
export function isLookingAt({ openChannelId, messageChannelId, pageHidden, windowHidden }: Attention): boolean {
  return openChannelId === messageChannelId && !pageHidden && !windowHidden;
}

/**
 * A message arrived in the chat that is open. With the window on screen it is read.
 * With the window hidden in the tray nobody has seen it: it is unread, unless it is
 * your own message from another device.
 */
export function arrivalInOpenChat(isWindowHidden: boolean, isFromMe: boolean): "read" | "unread" | "nothing" {
  if (!isWindowHidden) return "read";
  return isFromMe ? "nothing" : "unread";
}

/** Newest non-optimistic message id in a list — the read watermark. */
export function lastRealMessageId(msgs: readonly { id: string }[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].id.startsWith("temp-")) return msgs[i].id;
  }
  return undefined;
}
