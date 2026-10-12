// What Enter does in a message box (the composer and the edit box).

/** Where this matches, Send hides until there is something to send (index.css,
 *  .kc-composer-send): a mouse and a keyboard. Everywhere else it is always on screen. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export type EnterAction = "send" | "newline" | "ime";

export function enterAction(e: { shiftKey: boolean; isComposing: boolean }, finePointer: boolean): EnterAction {
  void finePointer;
  if (e.isComposing) return "ime";
  return e.shiftKey ? "newline" : "send";
}

/** True with a mouse and a keyboard. No matchMedia (a test, server rendering): true. */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(FINE_POINTER_QUERY).matches;
}
