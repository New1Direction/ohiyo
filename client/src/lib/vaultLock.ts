// The desktop vault's locked state. When the OS keychain can't be read or the sealed vault
// file can't be opened, the native vault stays locked rather than starting empty (which
// would overwrite the saved keys), and every vault command fails with an error that starts
// with this prefix (VAULT_LOCKED_PREFIX in src-tauri/src/vault.rs).
const VAULT_LOCKED_PREFIX = "vault_locked: ";

/** Why the vault is locked, when `err` is a vault command's locked error; otherwise null. */
export function vaultLockedReason(err: unknown): string | null {
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (message === null || !message.startsWith(VAULT_LOCKED_PREFIX)) return null;
  return message.slice(VAULT_LOCKED_PREFIX.length);
}
