import { useState } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { UserPanel } from "../../src/components/UserPanel";
import { ActivationChecklist } from "../../src/components/ActivationChecklist";
import type { PublicUser } from "../../src/api";
import type { Activity } from "../../src/gateway";
import type { ActivationState } from "../../src/lib/activation";
export { act };

const ME: PublicUser = { id: "u1", username: "kikka", display_name: "kikka", avatar_url: null };

/** The user panel as the sidebar renders it, with status and activity kept the way App
 *  keeps them. Every call the panel makes is written to `calls`. */
export function mountUserPanel(
  element: HTMLElement,
  init: { status?: string | null; activity?: Activity | null; privacyMode?: boolean } = {},
) {
  const calls: string[] = [];
  function Harness() {
    const [status, setStatus] = useState<string | null>(init.status ?? null);
    const [activity, setActivity] = useState<Activity | null>(init.activity ?? null);
    return (
      <UserPanel
        currentUser={ME}
        connStatus="connected"
        myStatus={status}
        onSetStatus={(s) => {
          calls.push(`status:${s}`);
          setStatus(s || null);
        }}
        myActivity={activity}
        onSetActivity={(a) => {
          calls.push(`activity:${a ? `${a.kind} ${a.name}` : "none"}`);
          setActivity(a);
        }}
        privacyMode={init.privacyMode ?? false}
        onLogout={() => calls.push("logout")}
        onOpenSettings={() => calls.push("settings")}
      />
    );
  }
  const root = createRoot(element);
  act(() => root.render(<Harness />));
  return { calls, unmount: () => act(() => root.unmount()) };
}

/** The owner checklist on its own, as the sidebar shows it. */
export function mountChecklist(element: HTMLElement, state: ActivationState) {
  const root = createRoot(element);
  act(() => root.render(<ActivationChecklist state={state} serverName="test" onDismiss={() => {}} />));
  return { unmount: () => act(() => root.unmount()) };
}
