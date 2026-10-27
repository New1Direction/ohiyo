import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import PresentationReview from "../../src/burrow/PresentationReview";
import type { BurrowTask } from "../../src/api";
export { presentationPptx, presentationSlides } from "../../src/burrow/presentation";
export { act };
export function mount(container: HTMLElement, task: BurrowTask) {
  const root = createRoot(container);
  act(() => root.render(<PresentationReview token="test-owner" task={task} onDirtyChange={() => {}} />));
  return () => act(() => root.unmount());
}
