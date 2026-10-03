// What signing out removes from this device: decrypted message plaintext (and its index),
// the outbox (unsent messages, in plaintext) and every composer draft. Identity and Signal
// session keys stay, so signing back in here keeps the same identity and sessions. Works
// on whatever stores it's given (localStorage, and the desktop vault) so it's unit-testable.

export type ListableStore = { keys: () => string[]; removeItem: (key: string) => void };

const CLEARED_PREFIXES = ["kc:e2e-pt:", "kc:draft:"];
const CLEARED_KEYS = ["kc:e2e-pt-index", "kc:outbox"];

const isClearedOnLogout = (key: string): boolean =>
  CLEARED_KEYS.includes(key) || CLEARED_PREFIXES.some((p) => key.startsWith(p));

export function clearLocalMessageData(stores: readonly ListableStore[]): void {
  for (const store of stores) {
    for (const key of store.keys()) {
      if (isClearedOnLogout(key)) store.removeItem(key);
    }
  }
}
