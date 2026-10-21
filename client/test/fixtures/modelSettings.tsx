import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import ModelSettings from "../../src/burrow/ModelSettings";
export { act };
export function mount(container: HTMLElement, props: ComponentProps<typeof ModelSettings>) {
  const root = createRoot(container);
  act(() => root.render(<ModelSettings {...props} />));
  return { unmount() { act(() => root.unmount()); } };
}
