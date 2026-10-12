import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { useDesktopShell } from "../../src/hooks/useDesktopShell";
import { SignedOutUpdates } from "../../src/components/SignedOutUpdates";
export { act };
export { fireShellEvent, shellCalls } from "./desktopShellStub";

function Shell({ unread, inCall }: { unread: number; inCall: boolean }) {
  useDesktopShell({ unread, inCall, onLeaveCall: () => {}, onCheckUpdates: () => {}, onWindowHidden: () => {} });
  return null;
}

/** The signed-in app's side of the shell, with some unread and a call going. */
export function mountSignedInShell(element: HTMLElement, unread: number, inCall: boolean) {
  const root = createRoot(element);
  act(() => root.render(<Shell unread={unread} inCall={inCall} />));
  return { unmount: () => act(() => root.unmount()) };
}

/** What the sign-in screen puts beside itself for the tray. */
export function mountSignedOutUpdates(element: HTMLElement) {
  const root = createRoot(element);
  act(() => root.render(<SignedOutUpdates />));
  return { unmount: () => act(() => root.unmount()) };
}
