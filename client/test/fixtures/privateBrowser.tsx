import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import PrivateBrowser from "../../src/burrow/PrivateBrowser";
export { act };
export function mount(container: HTMLElement) {
  const root = createRoot(container);
  act(() => root.render(<PrivateBrowser token="test-session" taskId="task" visible />));
  return () => act(() => root.unmount());
}
