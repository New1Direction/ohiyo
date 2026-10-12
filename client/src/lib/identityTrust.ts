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
// A contact's devices as the directory last listed them: "deviceId:identityKey" entries,
// sorted, joined with "|" (base64 keys contain neither ":" nor "|").
const DEVSET_NS = "kc:sig:devset:";
// CHANGED_NS values: a device's identity key changed, or a device was added.
const CHANGED_KEY = "1";
const CHANGED_DEVICE = "device";
// What "verified" held before it was tied to a device set. Treated as verified, and tied
// to the set seen next (recordDeviceSet).
const LEGACY_VERIFIED = "1";

export type DeviceKey = { device_id: number; identity_key: string };

const canonical = (rows: readonly DeviceKey[]): string =>
  rows.map((r) => `${r.device_id}:${r.identity_key}`).sort().join("|");
const entries = (s: string | null): Set<string> => new Set(s ? s.split("|").filter(Boolean) : []);

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
  return backend.getItem(CHANGED_NS + userId) !== null;
}

/**
 * Record a contact's devices as the directory lists them now. Every device can read what
 * you send them, so a device that wasn't there before is news: it raises the change
 * event (reason "device"), the same way a changed key does. The first list for a contact
 * is just recorded (trust on first use). A device that left is not news.
 * Never call this with your own account: deviceWatch covers that.
 */
export function recordDeviceSet(userId: string, rows: readonly DeviceKey[]): boolean {
  if (rows.length === 0) return false; // offline, or no keys yet: nothing to compare
  const next = canonical(rows);
  const prev = backend.getItem(DEVSET_NS + userId);
  if (prev === next) return false;
  backend.setItem(DEVSET_NS + userId, next);
  // A verification from before device sets were kept covers what was known then.
  if (backend.getItem(VERIFIED_NS + userId) === LEGACY_VERIFIED) backend.setItem(VERIFIED_NS + userId, prev ?? next);
  if (prev === null) return false;
  const before = entries(prev);
  if (rows.every((r) => before.has(`${r.device_id}:${r.identity_key}`))) return false; // only removals
  const knownIds = new Set([...before].map((e) => e.slice(0, e.indexOf(":"))));
  const reason = rows.some((r) => !knownIds.has(String(r.device_id))) ? CHANGED_DEVICE : CHANGED_KEY;
  // A changed key is the more serious news: a new device doesn't replace it.
  if (backend.getItem(CHANGED_NS + userId) !== CHANGED_KEY) backend.setItem(CHANGED_NS + userId, reason);
  notify(userId);
  return true;
}

/**
 * A message arrived from one of a contact's devices that this device had never heard from.
 * A server that hides a device from the directory can still deliver from it, so a device
 * (or key) the directory never listed is the same news as one it adds: it raises the
 * change event and joins the recorded set, which keeps the contact unverified until you
 * compare again. Before any list is known for the contact it is trust on first use.
 * Never call this with your own account: deviceWatch covers that.
 */
export function recordInboundDevice(userId: string, deviceId: number, identityKey: string): boolean {
  const prev = backend.getItem(DEVSET_NS + userId);
  if (prev === null) return false;
  const known = entries(prev);
  if (known.has(`${deviceId}:${identityKey}`)) return false;
  const idKnown = [...known].some((e) => e.slice(0, e.indexOf(":")) === String(deviceId));
  const reason = idKnown ? CHANGED_KEY : CHANGED_DEVICE;
  known.add(`${deviceId}:${identityKey}`);
  backend.setItem(DEVSET_NS + userId, [...known].sort().join("|"));
  // A changed key is the more serious news: a new device doesn't replace it.
  if (backend.getItem(CHANGED_NS + userId) !== CHANGED_KEY) backend.setItem(CHANGED_NS + userId, reason);
  notify(userId);
  return true;
}

/** Why the contact's safety number changed, if it did and you haven't dealt with it. */
export function changeReason(userId: string): "key" | "device" | null {
  const v = backend.getItem(CHANGED_NS + userId);
  return v === null ? null : v === CHANGED_DEVICE ? "device" : "key";
}

/** Dismiss a pending change. A change invalidates any prior verification, so
 *  acknowledging without re-verifying also drops the (now stale) verified flag —
 *  the user must not stay "verified" against a key they never confirmed. */
export function acknowledgeIdentityChange(userId: string): void {
  backend.removeItem(CHANGED_NS + userId);
  backend.removeItem(VERIFIED_NS + userId);
  notify(userId);
}

/** Verified, and every device the contact has now was among the ones you verified. A
 *  device added later is not covered: verifying is about the keys you compared. */
export function isVerified(userId: string): boolean {
  const v = backend.getItem(VERIFIED_NS + userId);
  if (v === null) return false;
  if (v === LEGACY_VERIFIED) return true;
  const current = backend.getItem(DEVSET_NS + userId);
  if (current === null) return true;
  const covered = entries(v);
  return [...entries(current)].every((e) => covered.has(e));
}

function wasVerified(userId: string): boolean {
  return backend.getItem(VERIFIED_NS + userId) !== null;
}

/** Mark a contact verified (user compared the safety number out-of-band), for the
 *  devices that number was made from (`keySet`; else the devices known now). This also
 *  clears any pending change — verifying IS the resolution of a key change. */
export function markVerified(userId: string, keySet?: readonly DeviceKey[]): void {
  const bound = keySet && keySet.length > 0 ? canonical(keySet) : (backend.getItem(DEVSET_NS + userId) ?? LEGACY_VERIFIED);
  backend.setItem(VERIFIED_NS + userId, bound);
  backend.removeItem(CHANGED_NS + userId);
  notify(userId);
}

export function clearVerified(userId: string): void {
  backend.removeItem(VERIFIED_NS + userId);
  notify(userId);
}

// ── Derived state for the UI ────────────────────────────────────────────────
// changed_verified        → LOUD: a contact you verified now has a different key.
// changed_unverified      → CALM: an unverified contact's key changed (likely benign).
// device_added_verified   → LOUD: a contact you verified has a device you didn't verify.
// device_added_unverified → CALM: an unverified contact added a device (usually them).
// verified                → a reassuring "Verified" badge.
// unverified              → the default encrypted-but-unverified state.
export type TrustState =
  | "unverified"
  | "verified"
  | "changed_unverified"
  | "changed_verified"
  | "device_added_unverified"
  | "device_added_verified";

export function trustState(userId: string): TrustState {
  const was = wasVerified(userId);
  switch (changeReason(userId)) {
    case "key":
      return was ? "changed_verified" : "changed_unverified";
    case "device":
      return was ? "device_added_verified" : "device_added_unverified";
  }
  if (was && !isVerified(userId)) return "device_added_verified";
  return was ? "verified" : "unverified";
}
