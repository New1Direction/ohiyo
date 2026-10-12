import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { MessageEditBox } from "../../src/components/MessageEditBox";
export { act };

/** The edit box with a message in it; records each save and cancel. */
export function mountEditBox(element: HTMLElement, value: string) {
  const calls: string[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <MessageEditBox
        value={value}
        onChange={() => {}}
        onSave={() => calls.push("save")}
        onCancel={() => calls.push("cancel")}
      />,
    ),
  );
  return { calls, unmount: () => act(() => root.unmount()) };
}
