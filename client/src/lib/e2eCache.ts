// Local plaintext cache for forward-secret (Signal) messages. The Double Ratchet
// destroys each message key after use, so ciphertext CANNOT be re-decrypted on a
// history reload — we decrypt once (live) and keep the plaintext here, keyed by
// message id. (Legacy static-key `v1.` messages are re-decryptable and skip this.)
//
// This is the standard trade-off for forward secrecy: the client holds the
// plaintext locally; the server never can. Bounded with FIFO eviction.

const PREFIX = "kc:e2e-pt:";
const INDEX = "kc:e2e-pt-index";
const MAX = 5000;

export function cachePlaintext(msgId: string, text: string): void {
  try {
    if (localStorage.getItem(PREFIX + msgId) !== null) return; // already cached
    localStorage.setItem(PREFIX + msgId, text);
    let idx: string[] = [];
    try {
      idx = JSON.parse(localStorage.getItem(INDEX) || "[]");
    } catch {
      idx = [];
    }
    idx.push(msgId);
    while (idx.length > MAX) {
      const old = idx.shift();
      if (old) localStorage.removeItem(PREFIX + old);
    }
    localStorage.setItem(INDEX, JSON.stringify(idx));
  } catch {
    /* storage full/disabled — non-fatal, the message just won't survive a reload */
  }
}

export function getCachedPlaintext(msgId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + msgId);
  } catch {
    return null;
  }
}
