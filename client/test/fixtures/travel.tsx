import { renderToStaticMarkup } from "react-dom/server";
import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import Travel, { SavedTravelText } from "../../src/burrow/Travel";
export { parseTravelMoney, travelMoney } from "../../src/burrow/Travel";
export function renderSaved(text: string) { return renderToStaticMarkup(<SavedTravelText text={text} />); }
export { act };
export function mount(container: HTMLElement, props: ComponentProps<typeof Travel>) {
  const root = createRoot(container);
  act(() => root.render(<Travel {...props} />));
  return () => act(() => root.unmount());
}
