import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import GeneratedPage from "../../src/burrow/GeneratedPage";
import { pageSchema, parsePage } from "../../src/burrow/catalog";
export { act, parsePage };
export const schema = z.toJSONSchema(pageSchema);
export function mount(container: HTMLElement, value: unknown) {
  const root = createRoot(container);
  act(() => root.render(<GeneratedPage value={value} />));
  return () => act(() => root.unmount());
}
