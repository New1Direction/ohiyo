import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import GeneratedPage from "../../src/burrow/GeneratedPage";
import Creation from "../../src/burrow/Creation";
import type { BurrowTask } from "../../src/api";
import { pageSchema, parsePage } from "../../src/burrow/catalog";
export { act, parsePage };
export const schema = z.toJSONSchema(pageSchema);
export function mount(container: HTMLElement, value: unknown) {
  const root = createRoot(container);
  act(() => root.render(<GeneratedPage value={value} />));
  return () => act(() => root.unmount());
}

export function mountCreation(container: HTMLElement, task: BurrowTask) {
  const root = createRoot(container);
  act(() => root.render(<Creation task={task} token="local-test" canRun={false} service={null} onUpdate={() => {}} onDirtyChange={() => {}} />));
  return () => act(() => root.unmount());
}
