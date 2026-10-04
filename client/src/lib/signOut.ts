// When this device's local message data (the decrypted-message cache, the outbox and
// drafts; see logoutCleanup.ts) is removed. The cache is the only readable copy of past
// encrypted messages, it is shared by every home on the device, and it can't be split
// between them. Its removal exists so one account's readable data isn't left for a
// different account:
//   - signing out (the sidebar): only when the last signed-in home signs out, after the
//     user confirms;
//   - an expired or revoked session (BootSplash's "Back to sign in"): never;
//   - signing in: only when a different user than the one who last used this home here
//     signs in and no other home is signed in, before anything loads.
// The "Now" forms read the homes as stored at that moment, so a home signed in from
// another tab counts. (Imports use .ts so node tests can load this module directly.)
import { loadHomes, type OhiyoHome } from "./homes.ts";

export function signOutRemovesLocalData(homes: readonly OhiyoHome[], homeId: string): boolean {
  const signedIn = homes.filter((h) => h.token !== null);
  return signedIn.length === 1 && signedIn[0].id === homeId;
}

/** A home with no remembered user counts as the same user: there is nothing to protect
 *  yet, and users upgrading from a build that didn't remember keep their history. */
export function signInRemovesLocalData(
  rememberedUserId: string | null | undefined,
  signedInUserId: string,
  anotherHomeSignedIn: boolean,
): boolean {
  return !anotherHomeSignedIn && Boolean(rememberedUserId) && rememberedUserId !== signedInUserId;
}

export function signOutRemovesLocalDataNow(homeId: string): boolean {
  return signOutRemovesLocalData(loadHomes(), homeId);
}

export function signInRemovesLocalDataNow(homeId: string, signedInUserId: string): boolean {
  const homes = loadHomes();
  const remembered = homes.find((h) => h.id === homeId)?.lastUserId;
  return signInRemovesLocalData(remembered, signedInUserId, homes.some((h) => h.id !== homeId && h.token !== null));
}
