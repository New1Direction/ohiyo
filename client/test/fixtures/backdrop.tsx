import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import Backdrop from "../../src/burrow/Backdrop";
export { act };
export function mount(container: HTMLElement) {
  const root = createRoot(container);
  act(() => root.render(<Backdrop paused />));
  return () => act(() => root.unmount());
}
