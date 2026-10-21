import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import KikkaReply from "../../src/burrow/KikkaReply";
export { act };
export function mount(container: HTMLElement, props: ComponentProps<typeof KikkaReply>) {
  const root = createRoot(container);
  act(() => root.render(<KikkaReply {...props} />));
  return {
    update(next: ComponentProps<typeof KikkaReply>) { act(() => root.render(<KikkaReply {...next} />)); },
    unmount() { act(() => root.unmount()); },
  };
}
