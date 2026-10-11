// Local cache for forward-secret (Signal) messages. The Double Ratchet destroys each
// message key after use, so ciphertext CANNOT be re-decrypted on a history reload — we
// decrypt once (live) and keep the plaintext here, keyed by message id. (Legacy
// static-key `v1.` messages are re-decryptable and skip this.)
//
// This is the standard trade-off for forward secrecy: the client holds the plaintext
// locally; the server never can. Bounded with FIFO eviction.
//
// AT-REST STORAGE (#13):
//   • Desktop (Tauri): routed through the encrypted vault (sync in-memory mirror +
//     async write-through). The plaintext is sealed-at-rest in an AES-256-GCM blob, not
//     written as plaintext to localStorage. Existing localStorage plaintext is migrated
//     into the vault and scrubbed at startup (see tauriVault initVaultBackend).
//   • Web: no OS-backed secure store exists in a browser sandbox, so plaintext stays in
//     localStorage. This is an inherent, accepted tradeoff for the web build — the same
//     constraint that applies to all browser-local message caches.
// The vault's synchronous mirror lets us keep this module's sync API without an
// invasive sync→async refactor across the decrypt path.

import { getVaultStore } from "./tauriVault";

const PREFIX = "kc:e2e-pt:";
const INDEX = "kc:e2e-pt-index";
const MAX = 5000;

type SyncStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** The desktop vault's batch removal: one write instead of one per key. */
  removeMany?: (keys: string[]) => void;
  /** Every key in the store. The desktop vault lists its own; localStorage has length/key(). */
  keys?: () => string[];
  length?: number;
  key?: (index: number) => string | null;
};

function storeKeys(s: SyncStore): string[] {
  if (s.keys) return s.keys();
  const out: string[] = [];
  for (let i = 0; i < (s.length ?? 0); i++) {
    const k = s.key?.(i);
    if (k != null) out.push(k);
  }
  return out;
}

// Prefer the encrypted vault on desktop; fall back to localStorage on web.
function store(): SyncStore {
  return getVaultStore() ?? localStorage;
}

// Each entry is stored as JSON {pt, expires_at}: the plaintext and the message's
// self-destruct time in unix seconds (null = never). Entries written before expiries were
// stored are the bare plaintext and never expire here.
type Entry = { pt: string; expires_at: number | null };

function decodeEntry(raw: string): Entry {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && Object.keys(v).length === 2) {
      const { pt, expires_at } = v as Record<string, unknown>;
      if (typeof pt === "string" && (expires_at === null || typeof expires_at === "number")) return { pt, expires_at };
    }
  } catch {
    /* not JSON: a bare entry from before expiries were stored */
  }
  return { pt: raw, expires_at: null };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isExpired = (e: Entry, now: number) => e.expires_at !== null && e.expires_at <= now;

// The earliest expires_at still cached in `store` (Infinity if none), so a read only sweeps
// the whole cache once something may have expired.
let nextExpiry: { store: SyncStore; at: number } | null = null;

// Drop every expired entry, including ones nothing will read again (a disappearing
// message that expired while the app was closed is never fetched, so never read).
function dropExpired(s: SyncStore, now: number): void {
  if (nextExpiry?.store === s && now < nextExpiry.at) return;
  let idx: string[] = [];
  try {
    idx = JSON.parse(s.getItem(INDEX) || "[]");
  } catch {
    idx = [];
  }
  let at = Infinity;
  const expired: string[] = [];
  const kept = idx.filter((id) => {
    const raw = s.getItem(PREFIX + id);
    if (raw === null) return true;
    const entry = decodeEntry(raw);
    if (isExpired(entry, now)) {
      expired.push(PREFIX + id);
      return false;
    }
    if (entry.expires_at !== null) at = Math.min(at, entry.expires_at);
    return true;
  });
  if (expired.length > 0) {
    if (s.removeMany) s.removeMany(expired);
    else for (const key of expired) s.removeItem(key);
  }
  if (kept.length !== idx.length) s.setItem(INDEX, JSON.stringify(kept));
  nextExpiry = { store: s, at };
}

// An entry written straight to the store, not through cachePlaintext, is missing from the
// index: the sweep above never sees it and the size bound never counts it. A restore from
// an older recovery backup writes entries that way (tauriVault importKeyMaterial), so a
// restored disappearing message nobody opens would stay on disk past its expiry. Fold such
// entries in: drop the ones already expired, and put the rest at the old end of the index,
// first to go when the cache is full.
function adoptUnindexed(s: SyncStore, now: number): void {
  let idx: string[] = [];
  try {
    idx = JSON.parse(s.getItem(INDEX) || "[]");
  } catch {
    idx = [];
  }
  const known = new Set(idx);
  const remove: string[] = [];
  const found: string[] = [];
  for (const key of storeKeys(s)) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (known.has(id)) continue;
    const raw = s.getItem(key);
    if (raw === null) continue;
    if (isExpired(decodeEntry(raw), now)) remove.push(key);
    else found.push(id);
  }
  if (found.length > 0) {
    const next = [...found, ...idx];
    while (next.length > MAX) remove.push(PREFIX + next.shift());
    s.setItem(INDEX, JSON.stringify(next));
  }
  if (remove.length > 0) {
    if (s.removeMany) s.removeMany(remove);
    else for (const key of remove) s.removeItem(key);
  }
}

/** Fold in entries missing from the index, then drop every expired entry. The app runs
 *  this once at sign-in, after the vault is up, so cleanup doesn't wait for the first
 *  encrypted message to be read. */
export function sweepPlaintextCache(): void {
  try {
    const s = store();
    const now = nowSeconds();
    adoptUnindexed(s, now);
    nextExpiry = null; // a full sweep, so newly indexed expiries are tracked
    dropExpired(s, now);
  } catch {
    /* storage disabled — non-fatal */
  }
}

export function cachePlaintext(msgId: string, text: string, expiresAt: number | null = null): void {
  try {
    const s = store();
    if (s.getItem(PREFIX + msgId) !== null) return; // already cached
    s.setItem(PREFIX + msgId, JSON.stringify({ pt: text, expires_at: expiresAt } satisfies Entry));
    if (expiresAt !== null && nextExpiry?.store === s) nextExpiry = { store: s, at: Math.min(nextExpiry.at, expiresAt) };
    let idx: string[] = [];
    try {
      idx = JSON.parse(s.getItem(INDEX) || "[]");
    } catch {
      idx = [];
    }
    idx.push(msgId);
    while (idx.length > MAX) {
      const old = idx.shift();
      if (old) s.removeItem(PREFIX + old);
    }
    s.setItem(INDEX, JSON.stringify(idx));
  } catch {
    /* storage full/disabled — non-fatal, the message just won't survive a reload */
  }
}

/** The cached plaintext, or null when absent or past its expires_at. Reading also drops
 *  every expired entry from storage. */
export function getCachedPlaintext(msgId: string): string | null {
  try {
    const s = store();
    const now = nowSeconds();
    dropExpired(s, now);
    const raw = s.getItem(PREFIX + msgId);
    if (raw === null) return null;
    const entry = decodeEntry(raw);
    if (!isExpired(entry, now)) return entry.pt;
    removeCachedPlaintext(msgId); // not in the index (see adoptUnindexed)
    return null;
  } catch {
    return null;
  }
}

/** Evict a cached plaintext. MUST be called when a message is deleted or a disappearing
 *  message's TTL lapses — otherwise the forward-secret plaintext lingers on disk (and on
 *  web, in plaintext localStorage) long after the message "disappeared", defeating the
 *  guarantee. Also drops it from the FIFO index so the bound stays accurate. */
export function removeCachedPlaintext(msgId: string): void {
  try {
    const s = store();
    s.removeItem(PREFIX + msgId);
    let idx: string[] = [];
    try {
      idx = JSON.parse(s.getItem(INDEX) || "[]");
    } catch {
      idx = [];
    }
    const next = idx.filter((id) => id !== msgId);
    if (next.length !== idx.length) s.setItem(INDEX, JSON.stringify(next));
  } catch {
    /* storage disabled — non-fatal */
  }
}
