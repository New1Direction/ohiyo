import { useEffect } from "react";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useToast } from "../hooks/useToast";
import { onShellEvent } from "../lib/desktopShell";
import { ToastStack } from "./ToastStack";
import { UpdateBar } from "./UpdateBar";

/**
 * The tray's "Check for updates" while nobody is signed in. The signed-in app answers it
 * the rest of the time; on the sign-in screen this does, in the same words. Does nothing
 * in a browser (no tray, and the check says nothing outside the desktop app).
 */
export function SignedOutUpdates() {
  const { toasts, push } = useToast();
  const appUpdate = useAppUpdate({ isSignedIn: false, onMessage: push });
  const { check } = appUpdate;

  useEffect(() => {
    let isStopped = false;
    let stop = () => {};
    void onShellEvent("check-updates", () => void check(true)).then((stopListening) => {
      if (isStopped) stopListening();
      else stop = stopListening;
    });
    return () => {
      isStopped = true;
      stop();
    };
  }, [check]);

  return (
    <>
      <ToastStack toasts={toasts} />
      {appUpdate.update && (
        <UpdateBar
          version={appUpdate.update.version}
          isInstalling={appUpdate.isInstalling}
          onInstall={() => void appUpdate.install()}
          onLater={appUpdate.dismiss}
        />
      )}
    </>
  );
}
