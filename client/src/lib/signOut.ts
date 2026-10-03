// Whether signing out of a home removes this device's local message data (the decrypted-
// message cache, the outbox and drafts; see logoutCleanup.ts). The cache is the only
// readable copy of past encrypted messages, and it is shared by every home on the device
// and can't be split between them. So it goes only when the last signed-in home signs out
// (after the user confirms); while another home stays signed in, nothing is removed.
import type { OhiyoHome } from "./homes";

export function signOutRemovesLocalData(homes: readonly OhiyoHome[], homeId: string): boolean {
  const signedIn = homes.filter((h) => h.token !== null);
  return signedIn.length === 1 && signedIn[0].id === homeId;
}
