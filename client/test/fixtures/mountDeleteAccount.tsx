import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "../../src/api";
import { DeleteAccount } from "../../src/components/settings/DeleteAccount";
export { act };

export type DeleteCall = { password: string; username: string };

/** The Delete account form for `username`, with the server call recorded, not sent. */
export function mountDeleteAccount(element: HTMLElement, username: string) {
  const calls: DeleteCall[] = [];
  const deleted: string[] = [];
  (api as { deleteAccount: unknown }).deleteAccount = async (_token: string, password: string, typed: string) => {
    calls.push({ password, username: typed });
  };
  const root = createRoot(element);
  act(() => root.render(<DeleteAccount token="t" username={username} onDeleted={() => deleted.push(username)} />));
  return { calls, deleted, unmount: () => act(() => root.unmount()) };
}
