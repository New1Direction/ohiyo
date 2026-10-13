import { useEffect, useState } from "react";

const TICK_MS = 1000;
// setTimeout's longest delay; a week-long time out is well inside it.
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The current time, ticking once a second while `active` (a countdown is showing). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

/** Whether a time out ending at `until` (unix seconds) is still on. Re-renders when it
 *  runs out, so the composer comes back by itself. */
export function useTimedOut(until: number | null | undefined): boolean {
  const [, setExpired] = useState(0);
  const on = until != null && until * 1000 > Date.now();
  useEffect(() => {
    if (until == null) return;
    const left = until * 1000 - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.min(left + 50, MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [until]);
  return on;
}
