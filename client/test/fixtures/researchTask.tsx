import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import ResearchTask from "../../src/burrow/ResearchTask";
import Burrow from "../../src/burrow/Burrow";
import { getApiBase } from "../../src/api";
export { act };
export function mount(container: HTMLElement, props: ComponentProps<typeof ResearchTask>) {
  const root = createRoot(container);
  const render = (next: ComponentProps<typeof ResearchTask>) => act(() => root.render(<ResearchTask {...next} />));
  render(props);
  return { render, unmount() { act(() => root.unmount()); } };
}

export function mountBurrow(container: HTMLElement, token: string) {
  sessionStorage.setItem(`burrow:session:${getApiBase()}`, token);
  const root = createRoot(container);
  act(() => root.render(<Burrow />));
  return { unmount() { act(() => root.unmount()); } };
}
