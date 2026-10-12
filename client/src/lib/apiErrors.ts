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

// The server's answer when an account at its device cap publishes keys for a new device
// (server/src/api/signal.rs: 403 "too many devices (max 10) — remove one first").
const DEVICE_CAP_ANSWER = "too many devices";

/** What to show when publishing this device's Signal keys was refused because the account
 *  already has 10 devices, else null. Other 403s are not the device cap. */
export function deviceLimitMessage(err: unknown): string | null {
  const isDeviceCap = apiStatus(err) === 403 && err instanceof Error && err.message.startsWith(DEVICE_CAP_ANSWER);
  return isDeviceCap
    ? "This account already has the maximum of 10 devices. Remove one in Settings → Privacy & security → Linked devices, then reopen Ohiyo."
    : null;
}

/** The server's reason when it refused a request as invalid (400), such as "too many
 *  attachments (max 10 per message)", else null. */
export function badRequestMessage(err: unknown): string | null {
  return apiStatus(err) === 400 && err instanceof Error && err.message.trim() ? err.message : null;
}

/** The server's minimum (server/src/api/auth.rs: "password must be ≥8 chars"). */
export const PASSWORD_MIN_LENGTH = 8;

/** What to show when changing the password failed. A 403 is a wrong current password
 *  (the session itself is fine), not a sign-out. */
export function passwordChangeMessage(err: unknown): string {
  switch (apiStatus(err)) {
    case 403:
      return "That isn't your current password.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    case 400:
      return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    case 401:
      return "Your session has ended. Sign in again, then change your password.";
    default:
      return "Couldn't change your password. Check your connection and try again.";
  }
}

/** What to show when deleting the account didn't go through. A refusal deleted nothing and
 *  says so; when the answer was lost (a dropped connection, a timeout, a proxy failing) the
 *  account may already be gone, so it can't say that. */
export function deleteAccountMessage(err: unknown): string {
  switch (apiStatus(err)) {
    case 403:
      return "That isn't your password. Nothing was deleted.";
    case 400:
      return "Type your username exactly as shown. Nothing was deleted.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    case 401:
      return "Your session has ended. If you just deleted your account, it's gone. If not, sign in again and try once more.";
    case 502:
      // The server's own answer names the Instant Server; a proxy's 502 doesn't.
      if (err instanceof Error && err.message.includes("Instant Server")) {
        return "Your Instant Server couldn't be shut down, so nothing was deleted. Try again in a minute.";
      }
      break;
  }
  return "We couldn't tell whether it went through. If your account is gone, this device will be signed out; if not, try again.";
}

/** What to show when deleting a space didn't go through. */
export function deleteSpaceMessage(err: unknown): string {
  switch (apiStatus(err)) {
    case 403:
      return "That isn't your password. Nothing was deleted.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    default:
      return "Couldn't delete the space. Check your connection and try again.";
  }
}

/** What to show when an action that asks for the password again was refused: a wrong
 *  password or too many tries, said plainly; anything else as `fallback`. */
export function passwordStepMessage(err: unknown, fallback: string): string {
  switch (apiStatus(err)) {
    case 403:
      return "That isn't your password.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    default:
      return fallback;
  }
}
