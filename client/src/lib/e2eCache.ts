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

export function cachePlaintext(msgId: string, text: string): void {
  try {
    const s = store();
    if (s.getItem(PREFIX + msgId) !== null) return; // already cached
    s.setItem(PREFIX + msgId, text);
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

export function getCachedPlaintext(msgId: string): string | null {
  try {
    return store().getItem(PREFIX + msgId);
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
