import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { VoiceTab } from "../../src/components/settings/VoiceTab";
export { act };

/** The Voice & video settings tab on its own. It reads and saves this device's voice settings. */
export function mountVoiceTab(element: HTMLElement) {
  const root = createRoot(element);
  act(() => root.render(<VoiceTab />));
  return { unmount: () => act(() => root.unmount()) };
}
