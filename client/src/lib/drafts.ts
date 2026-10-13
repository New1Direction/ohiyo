// Composer drafts persisted per channel so a half-written message survives a reload,
// not just a channel switch. Cleared on send. A chat in encrypted mode keeps its draft in
// memory only: saving one removes any stored copy instead of writing plaintext to disk.
//
// Which chats have a draft is kept here too, for the pencil beside them in the sidebar: read
// from storage once, then kept up to date as drafts are written. An encrypted chat's draft
// counts while it's in memory (until a reload).
const DRAFT_PREFIX = "kc:draft:";

let draftIds: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function storeDraft(channelId: string, text: string, encrypted: boolean) {
  try {
    if (text.trim() && !encrypted) localStorage.setItem(DRAFT_PREFIX + channelId, text);
    else localStorage.removeItem(DRAFT_PREFIX + channelId);
  } catch {
    /* storage off */
  }
}

function storedDraftIds(): Set<string> {
  const found = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX) && (localStorage.getItem(key) ?? "").trim()) found.add(key.slice(DRAFT_PREFIX.length));
    }
  } catch {
    /* storage off */
  }
  return found;
}

/** A new set (never changed in place) whenever a chat gains or loses a draft, and only then. */
function setHasDraft(channelId: string, has: boolean) {
  const current = getDraftIds();
  if (current.has(channelId) === has) return;
  const next = new Set(current);
  if (has) next.add(channelId);
  else next.delete(channelId);
  replaceDraftIds(next);
}

function replaceDraftIds(next: ReadonlySet<string>) {
  draftIds = next;
  for (const listener of [...listeners]) listener();
}

export function persistDraft(channelId: string, text: string, encrypted: boolean) {
  storeDraft(channelId, text, encrypted);
  setHasDraft(channelId, Boolean(text.trim()));
}

export function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + channelId) ?? "";
  } catch {
    return "";
  }
}

/** Remove the stored drafts of chats that just entered encrypted mode (in `next`, not in
 *  `prev`): a plaintext draft saved before must not stay on disk, even for a chat that
 *  isn't open (ChatPane only clears the open one). The draft itself stays in memory, so its
 *  pencil stays. */
export function dropDraftsEnteringEncryptedMode(prev: ReadonlySet<string>, next: ReadonlySet<string>) {
  for (const id of next) if (!prev.has(id)) storeDraft(id, "", true);
}

/** The chats with an unsent draft. The same set until one gains or loses a draft (safe for
 *  useSyncExternalStore). */
export function getDraftIds(): ReadonlySet<string> {
  if (!draftIds) draftIds = storedDraftIds();
  return draftIds;
}

export function subscribeDraftIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Signing out: forget every draft, stored and in memory. `keepStored` only forgets what's in
 *  memory, so the next read comes from storage (a fresh page). */
export function forgetAllDrafts(opts: { keepStored?: boolean } = {}): void {
  if (opts.keepStored) {
    draftIds = null;
    for (const listener of [...listeners]) listener();
    return;
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* storage off */
  }
  replaceDraftIds(new Set());
}
