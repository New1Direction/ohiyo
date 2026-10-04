import { useLayoutEffect, useRef, type RefObject } from "react";

/** Only sibling branches are dimmed. Never filter/inert an ancestor of the player. */
export function useWatchDream(
  playerRef: RefObject<HTMLDivElement | null>,
  toggleRef: RefObject<HTMLButtonElement | null>,
  enabled: boolean,
  onExit: () => void,
) {
  const originals = useRef(new Map<HTMLElement, boolean>());
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const saved = originals.current;
    const refresh = () => {
      const surrounding = new Set<HTMLElement>();
      for (let branch: HTMLElement | null = player; branch?.parentElement; branch = branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling !== branch && sibling instanceof HTMLElement && !["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) {
            surrounding.add(sibling);
          }
        }
        if (branch.parentElement === document.body) break;
      }
      for (const [element, inert] of saved) {
        if (!surrounding.has(element)) {
          element.inert = inert;
          element.classList.remove("kc-watch-surrounding", "kc-watch-surrounding--dream");
          saved.delete(element);
        }
      }
      for (const element of surrounding) {
        if (!saved.has(element)) saved.set(element, element.inert);
        element.classList.add("kc-watch-surrounding");
        element.classList.toggle("kc-watch-surrounding--dream", enabled);
        element.inert = enabled || saved.get(element)!;
      }
    };
    refresh();
    // Observe only the ancestor chain's direct children, not every incoming message.
    const observer = new MutationObserver(refresh);
    for (let ancestor = player.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { childList: true });
      if (ancestor === document.body) break;
    }
    const onKey = (event: KeyboardEvent) => {
      if (enabled && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitRef.current();
        toggleRef.current?.focus({ preventScroll: true });
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (enabled && event.target instanceof Node && !player.contains(event.target)) {
        toggleRef.current?.focus({ preventScroll: true });
      }
    };
    // No Tab trap: the iframe's native controls remain in the browser's focus order.
    if (enabled && !player.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      for (const [element, inert] of saved) {
        element.inert = inert;
        element.classList.remove("kc-watch-surrounding--dream");
      }
    };
  }, [enabled, playerRef, toggleRef]);

  useLayoutEffect(() => {
    const saved = originals.current;
    return () => {
      for (const [element, inert] of saved) {
        element.inert = inert;
        element.classList.remove("kc-watch-surrounding", "kc-watch-surrounding--dream");
      }
      saved.clear();
    };
  }, []);
}
