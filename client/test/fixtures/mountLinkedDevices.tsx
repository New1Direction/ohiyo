import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "../../src/api";
import { LinkedDevices } from "../../src/components/settings/LinkedDevices";
export { act };

export type ListedDevice = { device_id: number; updated_at: number };

/** Settings → Linked devices, with "Sign out everywhere" recorded, not sent. `list` answers
 *  the device list; by default it never arrives (the sign-out confirm doesn't wait for it). */
export function mountLinkedDevices(
  element: HTMLElement,
  list: () => Promise<ListedDevice[]> = () => new Promise(() => {}),
) {
  const signedOut: string[] = [];
  const listCalls: number[] = [];
  (api as { listDevices: unknown }).listDevices = () => {
    listCalls.push(Date.now());
    return list();
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <LinkedDevices token="t" onToast={() => {}} onSignOutEverywhere={async () => void signedOut.push("everywhere")} />,
    ),
  );
  return { signedOut, listCalls, unmount: () => act(() => root.unmount()) };
}
