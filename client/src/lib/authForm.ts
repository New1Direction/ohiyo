// What the sign-in screen says about usernames and passwords. New usernames use letters,
// numbers, dots, dashes and underscores (the server refuses anything else); signing in only
// checks the length, so names made before that rule still sign in.

import { MAX_USERNAME, MIN_USERNAME, USERNAME_CHAR } from "./usernames.ts";

export { MAX_USERNAME, MIN_USERNAME };

export type AuthMode = "login" | "register" | "link";

export const MIN_PASSWORD = 8;

export const USERNAME_RULE = "Letters, numbers, dots, dashes and underscores.";

const ONLY = "letters, numbers, dots, dashes and underscores only.";
const ALLOWED = new RegExp(`^${USERNAME_CHAR}$`);

/** What's wrong with a typed username, in plain words, or null when it's fine. */
export function usernameProblem(typed: string, mode: AuthMode): string | null {
  const name = typed.trim();
  if (name.length < MIN_USERNAME) return `A little longer — ${MIN_USERNAME}+ characters.`;
  if (name.length > MAX_USERNAME) return `Keep it under ${MAX_USERNAME} characters.`;
  if (mode !== "register") return null;
  const bad = [...name].find((c) => !ALLOWED.test(c));
  if (bad === undefined) return null;
  if (/\s/.test(bad)) return `No spaces — ${ONLY}`;
  return `"${bad}" can't go in a username — ${ONLY}`;
}

/** Map raw server/network errors to warm, human copy. */
export function friendlyAuthError(raw: string, mode: AuthMode): string {
  const m = raw.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) {
    return "Can't reach Ohiyo right now — check your connection and try again.";
  }
  if (m.includes("username taken")) return "That username's already taken — try another?";
  if (m.includes("invalid credentials")) return "Hmm, that username or password doesn't match.";
  if (m.includes("password")) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (m.includes("letters, numbers")) return "Usernames can use letters, numbers, dots, dashes and underscores.";
  if (m.includes("username")) return `Usernames are ${MIN_USERNAME}–${MAX_USERNAME} characters.`;
  if (mode === "login") return "Couldn't sign you in. Give it another go?";
  return "Couldn't create your account. Give it another go?";
}
