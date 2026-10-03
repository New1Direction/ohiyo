// Reading a failed API request. api.ts throws an Error whose message is the server's text
// and whose `status` is the HTTP status; this reads it without importing api.ts, so it
// stays unit-testable on its own.

/** The HTTP status of a failed API request, or null if `err` isn't one. */
export function apiStatus(err: unknown): number | null {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

/** What to show when sign-in or registration was rate-limited (429), else null. */
export function rateLimitMessage(err: unknown): string | null {
  return apiStatus(err) === 429 ? "Too many attempts. Try again in a few minutes." : null;
}

/** What to show when publishing this device's Signal keys was refused because the account
 *  already has 10 devices (403), else null. */
export function deviceLimitMessage(err: unknown): string | null {
  return apiStatus(err) === 403
    ? "This account already has the maximum of 10 devices. Remove one in Settings → Privacy & security → Linked devices, then reopen Ohiyo."
    : null;
}
