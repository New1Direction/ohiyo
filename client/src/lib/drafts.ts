// Composer drafts persisted per channel so a half-written message survives a reload,
// not just a channel switch. Cleared on send. A chat in encrypted mode keeps its draft in
// memory only: saving one removes any stored copy instead of writing plaintext to disk.
const DRAFT_PREFIX = "kc:draft:";

export function persistDraft(channelId: string, text: string, encrypted: boolean) {
  try {
    if (text.trim() && !encrypted) localStorage.setItem(DRAFT_PREFIX + channelId, text);
    else localStorage.removeItem(DRAFT_PREFIX + channelId);
  } catch {
    /* storage off */
  }
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
 *  isn't open (ChatPane only clears the open one). */
export function dropDraftsEnteringEncryptedMode(prev: ReadonlySet<string>, next: ReadonlySet<string>) {
  for (const id of next) if (!prev.has(id)) persistDraft(id, "", true);
}
