/**
 * Desktop key vault wiring (Tauri only).
 *
 * On the packaged desktop app, the E2E key material (Signal identity, ratchet state,
 * sender keys) lives in the native process's LOCKED, non-swappable RAM — never as
 * plaintext in on-disk localStorage. This module hydrates an in-memory mirror from the
 * native vault once at startup, then points the Signal + sender-key stores at it. Reads
 * are synchronous (the mirror); writes also flow to the native vault (sealed-at-rest).
 *
 * In a plain browser (web build, e2e) this is a no-op and the stores keep using
 * localStorage — there is no mlock in a browser sandbox.
 *
 * Honest limit: while a key is in active use the webview still copies it into JS heap.
 * The vault protects it AT REST (only an AES-256-GCM blob touches disk; the master key
 * lives in the OS keychain) and BURNS it on cue — it is not an in-use-heap guarantee.
 */

import { isDesktop } from "./desktop";
import { setSignalBackend } from "./signal";
import { setSenderKeyBackend } from "./senderKeys";
import { setE2eStore } from "./e2e";

// localStorage namespaces that hold E2E key material → moved into the vault. Covers
// Signal (kc:sig:), group sender keys (kc:sk:), and the legacy ECDH keypair.
const KEY_PREFIXES = ["kc:sig:", "kc:sk:", "kc:e2e-keypair"];

let mirror: Map<string, string> | null = null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Point the Signal + sender-key stores at the native locked-RAM vault. MUST be awaited
 * before initSignal (or any key access). Returns true if the vault is active, false in
 * a browser (callers then just keep localStorage).
 */
export async function initVaultBackend(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const snapshot = await invoke<Record<string, string>>("vault_snapshot");
    mirror = new Map(Object.entries(snapshot));

    // One-time migration: pull any key material still in localStorage (pre-vault
    // installs) into the vault, then scrub it off disk.
    for (const k of Object.keys(localStorage)) {
      if (!KEY_PREFIXES.some((p) => k.startsWith(p))) continue;
      const v = localStorage.getItem(k);
      if (v !== null && !mirror.has(k)) {
        mirror.set(k, v);
        void invoke("vault_set", { key: k, value: v });
      }
      localStorage.removeItem(k);
    }

    const m = mirror;
    const backend = {
      getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
      setItem: (k: string, v: string): void => {
        m.set(k, v);
        void invoke("vault_set", { key: k, value: v });
      },
      removeItem: (k: string): void => {
        m.delete(k);
        void invoke("vault_remove", { key: k });
      },
      keys: (): string[] => [...m.keys()],
    };
    setSignalBackend(backend);
    setSenderKeyBackend({ getItem: backend.getItem, setItem: backend.setItem });
    setE2eStore({ getItem: backend.getItem, setItem: backend.setItem });
    return true;
  } catch {
    return false; // vault unavailable — fall back to localStorage
  }
}

/**
 * Collect this device's E2E key material (Signal identity + ratchet, sender keys,
 * legacy keypair) for an encrypted recovery backup. Reads from the locked-RAM vault
 * on desktop, else from localStorage. Returns a plain key→value map (the caller
 * encrypts it under the recovery code before it ever leaves the device).
 */
export function exportKeyMaterial(): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = (k: string) => KEY_PREFIXES.some((p) => k.startsWith(p));
  if (isDesktop() && mirror) {
    for (const [k, v] of mirror) if (matches(k)) out[k] = v;
  } else {
    for (const k of Object.keys(localStorage)) {
      if (!matches(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  }
  return out;
}

/**
 * Restore key material from a decrypted recovery backup into this device's store
 * (the vault on desktop, else localStorage). Only known key-namespaces are written.
 */
export async function importKeyMaterial(material: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(material)) {
    if (!KEY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (isDesktop() && mirror) {
      mirror.set(k, v);
      await invoke("vault_set", { key: k, value: v });
    } else {
      localStorage.setItem(k, v);
    }
  }
}

/**
 * The dead-man's switch: burn the vault — wipe the locked RAM, delete the sealed
 * on-disk blob, and destroy the keychain master key. After this the keys are gone for
 * good and the user re-establishes E2E from scratch.
 */
export async function burnVault(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invoke("vault_burn");
    mirror?.clear();
  } catch {
    /* ignore */
  }
}
