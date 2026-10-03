// The desktop vault's locked state. When the OS keychain can't be read or the sealed vault
// file can't be opened, the native vault stays locked rather than starting empty (which
// would overwrite the saved keys), and every vault command fails with
// "vault_locked: <kind>: <reason>" (Locked::error in src-tauri/src/vault.rs).
const VAULT_LOCKED_PREFIX = "vault_locked: ";

/** keychain: the keychain couldn't be reached or read (retry; a reset can't help).
 *  vault: the keys saved on this device can't be opened (the user may reset). */
export type VaultLockKind = "keychain" | "vault";
export type VaultLocked = { kind: VaultLockKind; reason: string };

/** The kind and reason, when `err` is a vault command's locked error; otherwise null. A
 *  locked error without a known kind counts as a keychain lock, which offers no reset. */
export function parseVaultLocked(err: unknown): VaultLocked | null {
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (message === null || !message.startsWith(VAULT_LOCKED_PREFIX)) return null;
  const rest = message.slice(VAULT_LOCKED_PREFIX.length);
  const kinded = /^(keychain|vault): ([\s\S]*)$/.exec(rest);
  return kinded ? { kind: kinded[1] as VaultLockKind, reason: kinded[2] } : { kind: "keychain", reason: rest };
}
