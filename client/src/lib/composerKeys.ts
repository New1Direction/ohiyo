// What Enter does in a message box (the composer and the edit box).

/** Where this matches, Send hides until there is something to send (index.css,
 *  .kc-composer-send): a mouse and a keyboard. Everywhere else it is always on screen. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export type EnterAction = "send" | "newline" | "ime";

/** With a mouse and a keyboard, Enter sends and Shift+Enter starts a new line. On a touch
 *  screen there's no Shift key and Send is always showing, so Enter starts a new line, like
 *  Discord's phone app. Enter that confirms a word in an input method (Japanese, Chinese,
 *  Korean…) is the input method's either way. */
export function enterAction(e: { shiftKey: boolean; isComposing: boolean }, finePointer: boolean): EnterAction {
  if (e.isComposing) return "ime";
  if (e.shiftKey || !finePointer) return "newline";
  return "send";
}

/** True with a mouse and a keyboard. No matchMedia (a test, server rendering): true. */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(FINE_POINTER_QUERY).matches;
}
