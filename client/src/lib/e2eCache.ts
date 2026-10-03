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
};

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
  const kept = idx.filter((id) => {
    const raw = s.getItem(PREFIX + id);
    if (raw === null) return true;
    const entry = decodeEntry(raw);
    if (isExpired(entry, now)) {
      s.removeItem(PREFIX + id);
      return false;
    }
    if (entry.expires_at !== null) at = Math.min(at, entry.expires_at);
    return true;
  });
  if (kept.length !== idx.length) s.setItem(INDEX, JSON.stringify(kept));
  nextExpiry = { store: s, at };
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
    removeCachedPlaintext(msgId); // not in the index (e.g. restored from a backup)
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
