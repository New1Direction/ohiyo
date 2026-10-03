// localStorage is small and per-origin, and can fill up. The decrypted-message cache is
// most of what this app keeps there. A write that hits the quota evicts the oldest quarter
// of that cache and retries, repeating until the write fits or the cache is empty, so a
// full store costs the oldest readable history rather than all of it. The user is told
// once per session.

export type EvictableStore = {
  keys: () => string[];
  getItem?: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** The desktop vault's batch removal: one write instead of one per key. */
  removeMany?: (keys: string[]) => void;
};

// The decrypted-message cache's keys and FIFO index, oldest first (see e2eCache.ts).
const CACHE_PREFIX = "kc:e2e-pt:";
const CACHE_INDEX = "kc:e2e-pt-index";

const EVICTION_NOTICE = "Storage is full. Older decrypted messages were removed from this device.";
const evictionListeners = new Set<(notice: string) => void>();
let evictionNoticeShown = false;

/** Be told (once per session) when a full store removed older decrypted messages. */
export function onPlaintextCacheEvicted(listener: (notice: string) => void): () => void {
  evictionListeners.add(listener);
  return () => {
    evictionListeners.delete(listener);
  };
}

function noticeEviction(): void {
  if (evictionNoticeShown || evictionListeners.size === 0) return;
  evictionNoticeShown = true;
  for (const listener of evictionListeners) listener(EVICTION_NOTICE);
}

function isQuotaExceeded(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** The cache's entry keys, oldest first: entries the index doesn't list (older builds)
 *  first, then the index's FIFO order. */
function cacheKeysOldestFirst(store: EvictableStore): string[] {
  const present = new Set(store.keys().filter((k) => k.startsWith(CACHE_PREFIX)));
  let ids: unknown = [];
  try {
    ids = JSON.parse(store.getItem?.(CACHE_INDEX) ?? "[]");
  } catch {
    ids = [];
  }
  const indexed = (Array.isArray(ids) ? ids : [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => CACHE_PREFIX + id)
    .filter((k) => present.has(k));
  const listed = new Set(indexed);
  return [...[...present].filter((k) => !listed.has(k)), ...indexed];
}

function evict(store: EvictableStore, keys: string[], remaining: string[]): void {
  if (store.removeMany) store.removeMany(keys);
  else for (const k of keys) store.removeItem(k);
  // Keep the index in step with what's left (it only shrinks, so it fits).
  try {
    if (remaining.length === 0) store.removeItem(CACHE_INDEX);
    else store.setItem(CACHE_INDEX, JSON.stringify(remaining.map((k) => k.slice(CACHE_PREFIX.length))));
  } catch {
    /* a stale index only lists ids whose entries are gone */
  }
}

/** `store.setItem`, except that a full store loses the oldest quarter of the decrypted-
 *  message cache and the write is retried, until it fits or the cache is empty. Throws
 *  if it still doesn't fit then, or on any other error. */
export function setItemEvictingPlaintextCache(store: EvictableStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
    return;
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
  }
  let cache = cacheKeysOldestFirst(store);
  while (cache.length > 0) {
    const oldest = cache.slice(0, Math.ceil(cache.length / 4));
    cache = cache.slice(oldest.length);
    evict(store, oldest, cache);
    noticeEviction();
    try {
      store.setItem(key, value);
      return;
    } catch (err) {
      if (!isQuotaExceeded(err)) throw err;
    }
  }
  store.setItem(key, value);
}

/** window.localStorage as an EvictableStore (read lazily, so importing this is safe
 *  anywhere). */
export function localStorageStore(): EvictableStore {
  return {
    keys: () => Object.keys(localStorage),
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
  };
}

/** Persist the chats in encrypted mode. Runs inside React state updaters, so it never
 *  throws: if storage is still full (or disabled), the in-memory set stays correct and is
 *  saved by the next change. */
export function saveEncryptedChannels(ids: Iterable<string>): void {
  try {
    setItemEvictingPlaintextCache(localStorageStore(), "kc:e2e-channels", JSON.stringify([...ids]));
  } catch {
    /* still full or storage off */
  }
}
