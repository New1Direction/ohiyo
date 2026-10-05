// The app's side of the desktop shell: the tray, the dock badge, the close-to-tray
// setting and open-at-login. Every export does nothing in a browser and never throws,
// so callers need no checks. The commands are in client/src-tauri/src/{tray,prefs}.rs.
import { isDesktop } from "./desktop";

export type DesktopPrefs = { keep_running: boolean; tray_hint_shown: boolean };
export type ShellEvent = "leave-call" | "check-updates" | "window-hidden";

async function call<T>(command: string, args: Record<string, unknown> | undefined, fallback: T): Promise<T> {
  if (!isDesktop()) return fallback;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<T>(command, args)) ?? fallback;
  } catch (err) {
    console.warn(`[ohiyo] desktop shell: ${command} failed`, err);
    return fallback;
  }
}

/** A whole number of at least zero, whatever was passed in. */
function wholeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** The number on the dock icon and in the tray tooltip. */
export async function setUnreadBadge(count: number): Promise<void> {
  await call<null>("desktop_set_unread", { count: wholeCount(count) }, null);
}

/** Whether the tray menu offers "Leave call". */
export async function setInCall(inCall: boolean): Promise<void> {
  await call<null>("desktop_set_in_call", { inCall }, null);
}

export function getDesktopPrefs(): Promise<DesktopPrefs | null> {
  return call<DesktopPrefs | null>("desktop_prefs_get", undefined, null);
}

export function setKeepRunning(on: boolean): Promise<DesktopPrefs | null> {
  return call<DesktopPrefs | null>("desktop_prefs_set", { keepRunning: on }, null);
}

export function getOpenAtLogin(): Promise<boolean> {
  return call<boolean>("desktop_autostart_get", undefined, false);
}

/** Returns what the operating system now says, which can differ from what was asked. */
export function setOpenAtLogin(on: boolean): Promise<boolean> {
  return call<boolean>("desktop_autostart_set", { enabled: on }, false);
}

/** Listen for something the shell tells the app. Resolves to a function that stops listening. */
export async function onShellEvent(name: ShellEvent, handler: (payload: unknown) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen(`desktop://${name}`, (event) => handler(event.payload));
  } catch (err) {
    console.warn(`[ohiyo] desktop shell: couldn't listen for ${name}`, err);
    return () => {};
  }
}

export type AppUpdate = {
  version: string;
  /** Download, install and restart. Rejects if any step fails. */
  install: () => Promise<void>;
};

/**
 * Ask the release server for a newer version. Null when this copy is current or when not
 * running as the desktop app. Unlike the calls above, this one rejects when the check
 * itself fails, so the caller can tell "up to date" from "couldn't check".
 */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!isDesktop()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    install: async () => {
      await update.downloadAndInstall();
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("app_restart");
    },
  };
}
