import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import ResearchTask from "../../src/burrow/ResearchTask";
export { act };
export function mount(container: HTMLElement, props: ComponentProps<typeof ResearchTask>) {
  const root = createRoot(container);
  const render = (next: ComponentProps<typeof ResearchTask>) => act(() => root.render(<ResearchTask {...next} />));
  render(props);
  return { render, unmount() { act(() => root.unmount()); } };
}
