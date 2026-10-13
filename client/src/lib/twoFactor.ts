// Two-factor sign-in in the app: what the server's answers look like, what a typed code is,
// the recovery-codes file, and the messages people see. The server side is api/two_factor.rs.

/** The password step's answer when two-factor sign-in is on: no session yet. */
export type TwoFactorChallenge = { two_factor_required: true; challenge: string; expires_in?: number };
export type TwoFactorStatus = { enabled: boolean; available: boolean; recovery_codes_left: number };
export type TwoFactorSetup = { secret: string; otpauth_url: string };
export type RecoveryCodes = { recovery_codes: string[] };

/** The HTTP status of a failed API request (as lib/apiErrors.ts reads it; repeated here so
 *  this file has no imports and its tests run on their own). */
function apiStatus(err: unknown): number | null {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

/** The alphabet recovery codes are written in (RFC 4648 base32: no 0, 1, 8 or 9). */
const RECOVERY_ALPHABET = /^[A-Z2-7]{16}$/;

export function isTwoFactorChallenge(res: unknown): res is TwoFactorChallenge {
  if (!res || typeof res !== "object") return false;
  const r = res as Record<string, unknown>;
  return r.two_factor_required === true && typeof r.challenge === "string" && r.challenge.length > 0;
}

/** Six digits from the app, a recovery code, or neither yet. Spaces and dashes don't matter. */
export function codeKind(typed: string): "totp" | "recovery" | null {
  const compact = typed.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(compact)) return "totp";
  if (RECOVERY_ALPHABET.test(compact.toUpperCase())) return "recovery";
  return null;
}

/** The text of the recovery-codes file people save. */
export function recoveryCodesText(codes: string[], username: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return [
    `Ohiyo recovery codes for @${username}`,
    `Made ${day}`,
    "",
    "If you can't use your authenticator app, sign in with one of these instead.",
    "Each code works once. Keep them somewhere safe, away from your password.",
    "",
    ...codes,
    "",
  ].join("\n");
}

function isNetworkError(err: unknown): boolean {
  const m = err instanceof Error ? err.message.toLowerCase() : "";
  return m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed");
}

/** What to say when the code step of signing in didn't go through. */
export function signInCodeMessage(err: unknown): string {
  if (isNetworkError(err)) return "Can't reach Ohiyo right now — check your connection and try again.";
  switch (apiStatus(err)) {
    case 403:
      return "That code isn't right. Check your authenticator app and try again.";
    case 401:
      return "That took too long. Go back and sign in again.";
    case 429:
      return "Too many tries. Wait a minute, then try again.";
    case 503:
      return "Codes from your app can't be checked on this server right now. Use a recovery code.";
    default:
      return "Couldn't check that code. Try again?";
  }
}

/** What a settings form should say when the server wants a code, or the code was wrong.
 *  Null for any other refusal, which the form explains itself. */
export function stepUpCodeMessage(err: unknown): string | null {
  if (apiStatus(err) !== 403) return null;
  const m = err instanceof Error ? err.message.toLowerCase() : "";
  if (m.includes("enter the code")) return "Enter the code from your authenticator app, or a recovery code.";
  if (m.includes("code isn't right")) return "That code isn't right. Check your authenticator app and try again.";
  return null;
}

/** The window event that tells an open Settings card the status changed (App.tsx sends it
 *  on the gateway's TwoFactorUpdate). */
export const TWO_FACTOR_EVENT = "ohiyo:two-factor";

/** How long after a change made on this device its own announcement is ignored. */
const OWN_CHANGE_MS = 15_000;
let changedHereAt: number | null = null;

/** Note that this device just turned two-factor sign-in on or off. */
export function markTwoFactorChangedHere(): void {
  changedHereAt = Date.now();
}

export function twoFactorChangedHereAt(): number | null {
  return changedHereAt;
}

/** A change is worth a word unless this device made it a moment ago. */
export function shouldAnnounceTwoFactorChange(changedHere: number | null, now: number): boolean {
  return changedHere === null || now - changedHere > OWN_CHANGE_MS;
}
