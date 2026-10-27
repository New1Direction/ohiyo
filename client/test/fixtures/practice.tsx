import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import PresentationReview from "../../src/burrow/PresentationReview";
import type { BurrowTask } from "../../src/api";
export { act };
export function mount(container: HTMLElement, task: BurrowTask, onDirtyChange: (dirty: boolean) => void) {
  const root = createRoot(container);
  const update = (next: BurrowTask) => act(() => root.render(<PresentationReview token="test-owner" task={next} onDirtyChange={onDirtyChange} />));
  update(task);
  return { update, unmount: () => act(() => root.unmount()) };
}
