import { useEffect, useRef } from "react";
import { onShellEvent, setInCall, setUnreadBadge } from "../lib/desktopShell";

type Options = {
  /** Total unread across every chat. */
  unread: number;
  inCall: boolean;
  /** "Leave call" was chosen in the tray menu. */
  onLeaveCall: () => void;
  /** "Check for updates" was chosen in the tray menu. */
  onCheckUpdates: () => void;
  /** The window was hidden to the tray (true) or is back on screen (false). */
  onWindowHidden: (hidden: boolean) => void;
};

/** Keeps the desktop shell in step with the app. Does nothing in a browser. */
export function useDesktopShell({ unread, inCall, onLeaveCall, onCheckUpdates, onWindowHidden }: Options): void {
  useEffect(() => {
    void setUnreadBadge(unread);
  }, [unread]);

  useEffect(() => {
    void setInCall(inCall);
  }, [inCall]);

  // The handlers change every render; the listeners are set up once and read the latest.
  const handlers = useRef({ onLeaveCall, onCheckUpdates, onWindowHidden });
  useEffect(() => {
    handlers.current = { onLeaveCall, onCheckUpdates, onWindowHidden };
  });

  useEffect(() => {
    let isStopped = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (isStopped) stop();
      else stops.push(stop);
    };
    void onShellEvent("leave-call", () => handlers.current.onLeaveCall()).then(keep);
    void onShellEvent("check-updates", () => handlers.current.onCheckUpdates()).then(keep);
    void onShellEvent("window-hidden", (hidden) => handlers.current.onWindowHidden(hidden === true)).then(keep);
    return () => {
      isStopped = true;
      for (const stop of stops) stop();
    };
  }, []);
}
