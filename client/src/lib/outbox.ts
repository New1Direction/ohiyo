/**
 * Offline outbox — persists unsent (pending/failed) messages to localStorage so
 * they survive channel switches and reloads, and can be re-sent when connectivity
 * returns. Entries are full optimistic Message objects (with `_state` + `_send`).
 *
 * Reconciliation: an entry is removed the moment its real send succeeds (the
 * gateway echo then delivers the canonical message). Note: without a server-side
 * idempotency key, a send that the server accepted but whose response was lost
 * can be re-sent once on flush — a known, accepted trade-off for now.
 */
import type { Message } from "../api";
import { getVaultStore } from "./tauriVault";

const KEY = "kc:outbox";

// The outbox holds OPTIMISTIC messages including their raw plaintext `content`/`_send`
// (pre-encryption), so it must not sit in plaintext localStorage on desktop. Route it
// through the encrypted vault when available (desktop); fall back to localStorage on web,
// where no OS secure store exists — the same accepted tradeoff as the message cache.
type KvStore = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};
function store(): KvStore {
  return getVaultStore() ?? localStorage;
}

export function loadOutbox(): Message[] {
  try {
    const raw = store().getItem(KEY);
    return raw ? (JSON.parse(raw) as Message[]) : [];
  } catch {
    return [];
  }
}

function save(list: Message[]): void {
  try {
    store().setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

export function addToOutbox(m: Message): void {
  const list = loadOutbox().filter((x) => x.id !== m.id);
  list.push(m);
  save(list);
}

export function removeFromOutbox(id: string): void {
  save(loadOutbox().filter((x) => x.id !== id));
}

export function setOutboxState(id: string, state: "pending" | "failed"): void {
  save(loadOutbox().map((x) => (x.id === id ? { ...x, _state: state } : x)));
}

export function outboxForChannel(channelId: string): Message[] {
  return loadOutbox().filter((x) => x.channel_id === channelId);
}

/** Entries the app should attempt to (re)send when connectivity returns. */
export function pendingFailedOutbox(): Message[] {
  return loadOutbox().filter((x) => x._state === "failed");
}

/**
 * On startup, any entry still marked "pending" came from a session that closed
 * mid-send — it never confirmed, so treat it as failed (eligible for re-send).
 */
export function reconcileStalePending(): void {
  const list = loadOutbox();
  if (list.some((x) => x._state === "pending")) {
    save(list.map((x) => (x._state === "pending" ? { ...x, _state: "failed" } : x)));
  }
}
