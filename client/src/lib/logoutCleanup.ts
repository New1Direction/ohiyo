// What signing out removes from this device: decrypted message plaintext (and its index),
// the outbox (unsent messages, in plaintext) and every composer draft. Identity and Signal
// session keys stay, so signing back in here keeps the same identity and sessions. Works
// on whatever stores it's given (localStorage, and the desktop vault) so it's unit-testable.

// removeMany: one write per store, since every desktop vault write re-seals and fsyncs.
export type ListableStore = { keys: () => string[]; removeMany: (keys: string[]) => void };

const CLEARED_PREFIXES = ["kc:e2e-pt:", "kc:draft:"];
const CLEARED_KEYS = ["kc:e2e-pt-index", "kc:outbox"];

const isClearedOnLogout = (key: string): boolean =>
  CLEARED_KEYS.includes(key) || CLEARED_PREFIXES.some((p) => key.startsWith(p));

export function clearLocalMessageData(stores: readonly ListableStore[]): void {
  for (const store of stores) {
    const cleared = store.keys().filter(isClearedOnLogout);
    if (cleared.length > 0) store.removeMany(cleared);
  }
}

// After the account itself is deleted, its encryption keys are no use to anyone: the
// Signal identity, sessions and trust marks (kc:sig:), group sender keys (kc:sk:), the
// legacy keypair, and what this device knew about the account's devices (deviceWatch).
// Keys are per device, not per account, so only call this when no other signed-in
// account on this device shares them.
const ACCOUNT_KEY_PREFIXES = ["kc:sig:", "kc:sk:"];
const ACCOUNT_KEYS = ["kc:e2e-keypair"];

export function clearDeletedAccountData(stores: readonly ListableStore[], userId: string): void {
  const own = [`ohiyo:known-devices:${userId}`, `ohiyo:new-devices:${userId}`];
  for (const store of stores) {
    const cleared = store
      .keys()
      .filter(
        (key) =>
          isClearedOnLogout(key) ||
          ACCOUNT_KEYS.includes(key) ||
          own.includes(key) ||
          ACCOUNT_KEY_PREFIXES.some((p) => key.startsWith(p))
      );
    if (cleared.length > 0) store.removeMany(cleared);
  }
}
