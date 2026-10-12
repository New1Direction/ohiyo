import { useState, type ComponentProps } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { NewDeviceAlert } from "../../src/components/NewDeviceAlert";
import { SettingsModal } from "../../src/components/settings/SettingsModal";
export { act };

/** Settings open, with the new-device alert shown over it on demand, the way App renders
 *  both. "It was me" takes the alert away, as App does once the devices are acknowledged. */
export function mountAlertOverSettings(element: HTMLElement, settings: ComponentProps<typeof SettingsModal>) {
  const answers: string[] = [];
  let setShown: (shown: boolean) => void = () => {};
  function Harness() {
    const [shown, show] = useState(false);
    setShown = show;
    const devices = shown ? [{ device_id: 2, seen_at: Date.now() - 60_000 }] : [];
    return (
      <>
        <SettingsModal {...settings} />
        <NewDeviceAlert
          key={devices.map((d) => d.device_id).join(",")}
          devices={devices}
          busy={false}
          onKeep={() => {
            answers.push("keep");
            show(false);
          }}
          onRemove={() => answers.push("remove")}
        />
      </>
    );
  }
  const root = createRoot(element);
  act(() => root.render(<Harness />));
  return {
    answers,
    showAlert: () => act(() => setShown(true)),
    unmount: () => act(() => root.unmount()),
  };
}
