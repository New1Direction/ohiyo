import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { ConfirmWithPassword } from "../../src/components/settings/ConfirmWithPassword";
export { act };

/** The password step with its callbacks recorded. */
export function mountConfirmWithPassword(element: HTMLElement) {
  const confirmed: string[] = [];
  let cancelled = 0;
  const root = createRoot(element);
  act(() =>
    root.render(
      <ConfirmWithPassword
        confirmLabel="Back up my keys"
        onConfirm={(password) => {
          confirmed.push(password);
        }}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    ),
  );
  return { confirmed, cancelled: () => cancelled, unmount: () => act(() => root.unmount()) };
}
