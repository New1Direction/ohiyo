import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { NewDeviceAlert } from "../../src/components/NewDeviceAlert";
export { act };

/** The new-device alert for one device, with the answers recorded. */
export function mountNewDeviceAlert(element: HTMLElement) {
  const answers: string[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <NewDeviceAlert
        devices={[{ device_id: 2, seen_at: Date.now() - 60_000 }]}
        busy={false}
        onKeep={() => answers.push("keep")}
        onRemove={() => answers.push("remove")}
      />,
    ),
  );
  return { answers, unmount: () => act(() => root.unmount()) };
}
