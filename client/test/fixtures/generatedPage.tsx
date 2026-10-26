import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { useState } from "react";
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

export function mountCreation(container: HTMLElement, task: BurrowTask, canRun = false) {
  const root = createRoot(container);
  function Conversation() {
    const [current, setCurrent] = useState(task);
    return <Creation task={current} token="local-test" canRun={canRun} service="the test service" onUpdate={setCurrent} onDirtyChange={() => {}} />;
  }
  act(() => root.render(<Conversation />));
  return () => act(() => root.unmount());
}
