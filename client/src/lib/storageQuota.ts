// localStorage is small and per-origin, and can fill up. The decrypted-message cache is
// most of what this app keeps there and can be dropped (its messages then show as
// undecryptable), so a write that hits the quota evicts that cache and retries once.

export type EvictableStore = {
  keys: () => string[];
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** The desktop vault's batch removal: one write instead of one per key. */
  removeMany?: (keys: string[]) => void;
};

// The decrypted-message cache's keys (see e2eCache.ts).
const isPlaintextCacheKey = (key: string): boolean => key.startsWith("kc:e2e-pt:") || key === "kc:e2e-pt-index";

function isQuotaExceeded(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** `store.setItem`, except that a full store first loses the decrypted-message cache and
 *  the write is retried once. Throws if the retry fails too, or on any other error. */
export function setItemEvictingPlaintextCache(store: EvictableStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
    return;
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
  }
  const cache = store.keys().filter(isPlaintextCacheKey);
  if (store.removeMany) store.removeMany(cache);
  else for (const k of cache) store.removeItem(k);
  store.setItem(key, value);
}

/** Persist the chats in encrypted mode. Runs inside React state updaters, so it never
 *  throws: if storage is still full (or disabled), the in-memory set stays correct and is
 *  saved by the next change. */
export function saveEncryptedChannels(ids: Iterable<string>): void {
  try {
    const browser: EvictableStore = {
      keys: () => Object.keys(localStorage),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
    };
    setItemEvictingPlaintextCache(browser, "kc:e2e-channels", JSON.stringify([...ids]));
  } catch {
    /* still full or storage off */
  }
}
