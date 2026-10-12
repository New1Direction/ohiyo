import { useLayoutEffect, useRef } from "react";

/** A confirm step that takes the place of the button that opened it. Without help, focus
 *  falls to the page when that button goes: a keyboard user starts again from the top and
 *  a screen reader reads nothing of the question. Focus goes to the question when the step
 *  opens and back to the button when it closes. The first render never takes focus. */
export function useConfirmFocus<Question extends HTMLElement, Opener extends HTMLElement>(confirming: boolean) {
  const question = useRef<Question>(null);
  const opener = useRef<Opener>(null);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (confirming) opened.current = true;
    if (!opened.current) return;
    (confirming ? question : opener).current?.focus();
  }, [confirming]);
  return { question, opener };
}
