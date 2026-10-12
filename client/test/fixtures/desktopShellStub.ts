// Stands in for src/lib/desktopShell in render tests: records what the app tells the
// shell, and lets a test fire what the shell tells the app (a tray menu choice).
import type { AppUpdate, ShellEvent } from "../../src/lib/desktopShell";
export type { AppUpdate, DesktopPrefs, ShellEvent } from "../../src/lib/desktopShell";

export const shellCalls: Array<[string, unknown]> = [];
const listeners = new Map<ShellEvent, Set<(payload: unknown) => void>>();

export async function setUnreadBadge(count: number): Promise<void> {
  shellCalls.push(["unread", count]);
}

export async function setInCall(inCall: boolean): Promise<void> {
  shellCalls.push(["inCall", inCall]);
}

export async function onShellEvent(name: ShellEvent, handler: (payload: unknown) => void): Promise<() => void> {
  const set = listeners.get(name) ?? new Set();
  listeners.set(name, set);
  set.add(handler);
  return () => set.delete(handler);
}

export function fireShellEvent(name: ShellEvent, payload?: unknown): number {
  const set = listeners.get(name) ?? new Set();
  for (const handler of set) handler(payload);
  return set.size;
}

export async function checkForUpdate(): Promise<AppUpdate | null> {
  shellCalls.push(["check", null]);
  return null;
}
