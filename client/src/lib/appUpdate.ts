// What the app says about updates. Pure, for unit tests.

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Shown when a download or install fails. Retrying rarely helps: a Mac app run from the
 * disk image or the Downloads folder can never replace itself. */
export const UPDATE_INSTALL_FAILED = "The update couldn't be installed. Download the new version from ohiyo.gg instead.";

export type UpdateCheckOutcome =
  | { kind: "available"; version: string }
  | { kind: "current" }
  | { kind: "failed" }
  /** This copy was not built by the release workflow, so it never looks. */
  | { kind: "unavailable" };

/**
 * Only a build made by the release workflow looks for updates (it sets
 * VITE_DESKTOP_UPDATES=1). A copy someone builds by hand still carries the official key
 * and address; if it looked, it would install the official build over theirs.
 */
export function updatesEnabled(flag: string | undefined): boolean {
  return flag === "1";
}

export function updateReadyLabel(version: string): string {
  return `Ohiyo ${version} is ready`;
}

/**
 * The toast for a finished check, or null for none. An available update is announced by
 * the bar. Checks the app starts by itself stay silent; one the person asked for answers.
 */
export function updateCheckMessage(outcome: UpdateCheckOutcome, isManual: boolean): string | null {
  if (outcome.kind === "available" || !isManual) return null;
  if (outcome.kind === "unavailable") return "This copy of Ohiyo doesn't update itself.";
  return outcome.kind === "current" ? "Ohiyo is up to date." : "Couldn't check for updates. Try again later.";
}

/** "Later" hides the bar until the next start, unless the person asks again. */
export function showsUpdateBar(isManual: boolean, wasDismissed: boolean): boolean {
  return isManual || !wasDismissed;
}
