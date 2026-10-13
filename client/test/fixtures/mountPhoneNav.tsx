import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { PhoneTabBar, type PhoneTab } from "../../src/components/PhoneTabBar";
import { ModalShell } from "../../src/components/ModalShell";
export { act };

/** The phone tab bar, recording which tab was tapped. */
export function mountPhoneTabBar(element: HTMLElement, props: { active: PhoneTab; dmUnread: number; mentionCount: number }) {
  const picked: string[] = [];
  const root = createRoot(element);
  act(() => root.render(<PhoneTabBar {...props} onSelect={(tab) => picked.push(tab)} />));
  return { picked, unmount: () => act(() => root.unmount()) };
}

/** A dialog shown the way the member list is on a phone: a panel from the right. */
export function mountSideModal(element: HTMLElement) {
  const root = createRoot(element);
  act(() =>
    root.render(
      <ModalShell onClose={() => {}} labelledBy="side-title" placement="side">
        <h2 id="side-title">Members</h2>
        <button type="button">Ben</button>
      </ModalShell>,
    ),
  );
  return { unmount: () => act(() => root.unmount()) };
}
