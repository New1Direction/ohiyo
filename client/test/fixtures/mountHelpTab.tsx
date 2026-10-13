import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { HelpTab, type ServiceStatus } from "../../src/components/settings/HelpTab";
export { act };

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Settings → Help & feedback, with the live status answered by `status` (or failing). */
export function mountHelpTab(element: HTMLElement, status: ServiceStatus | "fail") {
  const root = createRoot(element);
  const loadStatus = () => (status === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(status));
  act(() =>
    root.render(
      <HelpTab
        version="0.3.1"
        desktop={false}
        home="https://api.example.com/api/v1?token=secret-token"
        userAgent={MAC_CHROME}
        loadStatus={loadStatus}
      />,
    ),
  );
  return { unmount: () => act(() => root.unmount()) };
}
