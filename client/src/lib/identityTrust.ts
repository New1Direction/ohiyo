// Identity-change detection + verification state — the "safety number changed"
// trust layer that makes Signal-style verification actually defend against an
// ACTIVELY malicious server (not just a passive one).
//
// The Signal store already knows when a peer device's identity key changes
// (saveIdentity compares the stored key to the incoming one). On its own that
// boolean is thrown away, so a swapped prekey bundle is silent. This module is
// where the change becomes durable, observable state:
//
//   • a per-USER "changed" flag (safety numbers are per-contact, not per-device),
//   • a per-USER "verified" flag the user sets by comparing the safety number,
//   • a derived `trustState` the UI renders as a LOUD re-verify warning for a
//     previously-verified contact, or a CALM informational notice otherwise
//     (so a benign reinstall/new-device doesn't cause alarm fatigue).
//
// Deliberately dependency-free (no libsignal/api/crypto) so the change-event
// behaviour is unit-testable in isolation with an injected backend.

// ── Pluggable storage (localStorage in the browser; the locked-RAM vault on
//    desktop; an in-memory map in tests). Mirrors signal.ts's backend so the
//    flags follow the same store as the keys they describe. ────────────────────
export type TrustBackend = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

let backend: TrustBackend = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/** Point the trust flags at the same backend as the Signal key store. Called from
 *  signal.ts's setSignalBackend so desktop (vault) and tests wire it once. */
export function setIdentityTrustBackend(b: TrustBackend): void {
  backend = b;
}

// Share signal.ts's "kc:sig:" namespace so the vault's key-material prefix picks
// these up at rest too (they are integrity metadata, not secrets, but co-locating
// them with the identities they guard is correct and simplest).
const CHANGED_NS = "kc:sig:keychanged:";
const VERIFIED_NS = "kc:sig:verified:";

// ── Live change notifications (so the banner appears mid-session, not only on
//    reload). Persistence is the source of truth; listeners are just a nudge. ───
type IdentityChangeListener = (userId: string) => void;
const listeners = new Set<IdentityChangeListener>();

/** Subscribe to any trust-state change for any user (key change, verify, dismiss).
 *  Returns an unsubscribe function. Shaped as a `(cb) => unsubscribe` store so it
 *  drops straight into React's useSyncExternalStore. */
export function onIdentityChange(cb: IdentityChangeListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(userId: string): void {
  // Copy first so a listener that unsubscribes mid-dispatch is safe.
  for (const cb of [...listeners]) cb(userId);
}

/** Record that we saw `nextKeyB64` as a peer's identity key, given the key we had
 *  stored before (`prevKeyB64`, or undefined on first contact). Returns true and
 *  raises the change event iff this is a CHANGE of a key we already knew — a
 *  first-seen device is trust-on-first-use, not a change. */
export function recordKeySeen(
  userId: string,
  prevKeyB64: string | undefined,
  nextKeyB64: string,
): boolean {
  const changed = prevKeyB64 !== undefined && prevKeyB64 !== nextKeyB64;
  if (changed) {
    backend.setItem(CHANGED_NS + userId, "1");
    notify(userId);
  }
  return changed;
}

export function identityChanged(userId: string): boolean {
  return backend.getItem(CHANGED_NS + userId) === "1";
}

/** Dismiss a pending change. A change invalidates any prior verification, so
 *  acknowledging without re-verifying also drops the (now stale) verified flag —
 *  the user must not stay "verified" against a key they never confirmed. */
export function acknowledgeIdentityChange(userId: string): void {
  backend.removeItem(CHANGED_NS + userId);
  backend.removeItem(VERIFIED_NS + userId);
  notify(userId);
}

export function isVerified(userId: string): boolean {
  return backend.getItem(VERIFIED_NS + userId) === "1";
}

/** Mark a contact verified (user compared the safety number out-of-band). This
 *  also clears any pending change — verifying IS the resolution of a key change. */
export function markVerified(userId: string): void {
  backend.setItem(VERIFIED_NS + userId, "1");
  backend.removeItem(CHANGED_NS + userId);
  notify(userId);
}

export function clearVerified(userId: string): void {
  backend.removeItem(VERIFIED_NS + userId);
  notify(userId);
}

// ── Derived state for the UI ────────────────────────────────────────────────
// changed_verified   → LOUD: a contact you verified now has a different key.
// changed_unverified → CALM: an unverified contact's key changed (likely benign).
// verified           → a reassuring "Verified" badge.
// unverified         → the default encrypted-but-unverified state.
export type TrustState = "unverified" | "verified" | "changed_unverified" | "changed_verified";

export function trustState(userId: string): TrustState {
  const changed = identityChanged(userId);
  const verified = isVerified(userId);
  if (changed) return verified ? "changed_verified" : "changed_unverified";
  return verified ? "verified" : "unverified";
}
