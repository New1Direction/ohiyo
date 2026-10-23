import { type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import KikkaReply from "../../src/burrow/KikkaReply";
import { KikkaMotion } from "../../src/burrow/KikkaMascot";
export { act };
type Props = ComponentProps<typeof KikkaReply> & { motion?: boolean };
export function mount(container: HTMLElement, props: Props) {
  const root = createRoot(container);
  const render = (next: Props) => <KikkaMotion.Provider value={next.motion ?? true}><KikkaReply {...next} /></KikkaMotion.Provider>;
  act(() => root.render(render(props)));
  return {
    update(next: Props) { act(() => root.render(render(next))); },
    unmount() { act(() => root.unmount()); },
  };
}
