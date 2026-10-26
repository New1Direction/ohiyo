import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import ProjectReview from "../../src/burrow/ProjectReview";
export { act };
export function mount(container: HTMLElement) {
  const root = createRoot(container);
  act(() => root.render(<ProjectReview token="test-owner" taskId="task" version={0} onDirtyChange={() => {}} />));
  return () => act(() => root.unmount());
}
