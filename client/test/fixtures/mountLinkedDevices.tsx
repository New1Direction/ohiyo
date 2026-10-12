import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "../../src/api";
import { LinkedDevices } from "../../src/components/settings/LinkedDevices";
export { act };

/** Settings → Linked devices, with "Sign out everywhere" recorded, not sent. The device
 *  list never arrives: these tests are about the sign-out confirm, which doesn't wait for it. */
export function mountLinkedDevices(element: HTMLElement) {
  const signedOut: string[] = [];
  (api as { listDevices: unknown }).listDevices = () => new Promise(() => {});
  const root = createRoot(element);
  act(() =>
    root.render(
      <LinkedDevices token="t" onToast={() => {}} onSignOutEverywhere={async () => void signedOut.push("everywhere")} />,
    ),
  );
  return { signedOut, unmount: () => act(() => root.unmount()) };
}
