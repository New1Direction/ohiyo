import { useState } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { AuthScreen } from "../../src/components/AuthScreen";
import { AccountRecovery } from "../../src/components/settings/AccountRecovery";
import { ChangePassword } from "../../src/components/settings/ChangePassword";
export { act };

export function mountRecoverySettings(element: HTMLElement, needsCode = false) {
  function Settings() {
    const [token, setToken] = useState("test-session");
    return <>
      <ChangePassword token={token} username="alice" needsCode={needsCode} onChanged={setToken} onToast={() => {}} />
      <AccountRecovery key={token} token={token} username="alice" needsCode={needsCode} />
    </>;
  }
  const root = createRoot(element);
  act(() => root.render(<Settings />));
  return { unmount: () => act(() => root.unmount()) };
}

export function mountRecoveryDoor(element: HTMLElement) {
  const signedIn: string[] = [];
  const home = { id: "test", name: "Ohiyo", url: "http://localhost", token: null };
  const root = createRoot(element);
  act(() => root.render(<AuthScreen home={home} homes={[home]} onAuth={(token) => signedIn.push(token)} onSwitchHome={() => {}} onAddHome={() => {}} />));
  return { signedIn, unmount: () => act(() => root.unmount()) };
}
