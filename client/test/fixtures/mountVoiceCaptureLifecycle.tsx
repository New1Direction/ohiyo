import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { VoiceTab } from "../../src/components/settings/VoiceTab";
export { act };

// Call transitions and capture cancellation use the actual Settings tab.
export function mountVoiceTab(element: HTMLElement, voiceActive = false) {
  const root = createRoot(element);
  const render = (active: boolean) => act(() => root.render(<VoiceTab voiceActive={active} />));
  render(voiceActive);
  return { render, unmount: () => act(() => root.unmount()) };
}
