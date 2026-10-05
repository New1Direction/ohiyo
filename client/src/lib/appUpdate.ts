// What the app says about updates. Pure, for unit tests.

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateCheckOutcome = { kind: "available"; version: string } | { kind: "current" } | { kind: "failed" };

export function updateReadyLabel(version: string): string {
  return `Ohiyo ${version} is ready`;
}

/**
 * The toast for a finished check, or null for none. An available update is announced by
 * the bar. Checks the app starts by itself stay silent; one the person asked for answers.
 */
export function updateCheckMessage(outcome: UpdateCheckOutcome, isManual: boolean): string | null {
  if (outcome.kind === "available" || !isManual) return null;
  return outcome.kind === "current" ? "Ohiyo is up to date." : "Couldn't check for updates. Try again later.";
}

/** "Later" hides the bar until the next start, unless the person asks again. */
export function showsUpdateBar(isManual: boolean, wasDismissed: boolean): boolean {
  return isManual || !wasDismissed;
}
