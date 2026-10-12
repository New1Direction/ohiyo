import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "../../src/api";
import { AuthScreen } from "../../src/components/AuthScreen";
export { act };

/** The sign-in door, with sign-ups recorded, not sent. */
export function mountAuthScreen(element: HTMLElement) {
  const registered: string[] = [];
  (api as { register: unknown }).register = async (username: string) => {
    registered.push(username);
    throw new Error("username taken");
  };
  const home = { id: "test", name: "Ohiyo", url: "http://localhost", token: null };
  const root = createRoot(element);
  act(() =>
    root.render(
      <AuthScreen home={home} homes={[home]} onAuth={() => {}} onSwitchHome={() => {}} onAddHome={() => {}} />,
    ),
  );
  return { registered, unmount: () => act(() => root.unmount()) };
}
