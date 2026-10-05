import { useCallback, useEffect, useRef, useState } from "react";
import { UPDATE_CHECK_INTERVAL_MS, showsUpdateBar, updateCheckMessage, type UpdateCheckOutcome } from "../lib/appUpdate";
import { isDesktop } from "../lib/desktop";
import { checkForUpdate, type AppUpdate } from "../lib/desktopShell";

type Options = {
  /** Checks start once someone is signed in. */
  isSignedIn: boolean;
  /** Says something to the person: the answer to a check they asked for, or a failed install. */
  onMessage: (text: string, type: "info" | "error") => void;
};

/** Desktop updates: the app looks, the person decides. Does nothing in a browser. */
export function useAppUpdate({ isSignedIn, onMessage }: Options) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const wasDismissedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const check = useCallback(async (isManual: boolean) => {
    let outcome: UpdateCheckOutcome;
    try {
      const found = await checkForUpdate();
      setUpdate(found && showsUpdateBar(isManual, wasDismissedRef.current) ? found : null);
      outcome = found ? { kind: "available", version: found.version } : { kind: "current" };
    } catch (err) {
      console.warn("[ohiyo] update check failed", err);
      outcome = { kind: "failed" };
    }
    const message = updateCheckMessage(outcome, isManual);
    if (message) onMessageRef.current(message, outcome.kind === "failed" ? "error" : "info");
  }, []);

  useEffect(() => {
    if (!isDesktop() || !isSignedIn) return;
    void check(false);
    const timer = setInterval(() => void check(false), UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isSignedIn, check]);

  const install = useCallback(async () => {
    if (!update) return;
    setIsInstalling(true);
    try {
      await update.install();
    } catch (err) {
      console.warn("[ohiyo] update failed", err);
      setIsInstalling(false);
      onMessageRef.current("The update couldn't be installed. Try again later.", "error");
    }
  }, [update]);

  const dismiss = useCallback(() => {
    wasDismissedRef.current = true;
    setUpdate(null);
  }, []);

  return { update, isInstalling, check, install, dismiss };
}
