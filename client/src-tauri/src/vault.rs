//! Tauri glue for the locked-RAM E2E key vault (dazai/goodnight-backed). Holds the
//! vault + a master key in the NATIVE process; persists only an AES-256-GCM **sealed**
//! blob to app data (never plaintext on disk); and exposes get/set/remove/burn to the
//! webview so the JS Signal + sender-key stores can live in locked RAM instead of
//! `localStorage`. The master key lives in the OS keychain. `vault_burn` is the
//! dead-man's switch: wipe RAM + delete the sealed blob + destroy the keychain key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use kikka_vault::Vault;
use rand::RngCore;
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "kikkacord";
const KEYRING_ACCOUNT: &str = "vault-master";
const VAULT_FILE: &str = "kc-vault.bin";

/// Namespaces the webview is allowed to persist into the vault. Anything outside
/// these prefixes is rejected by `vault_set` so a compromised/buggy frontend
/// can't dump arbitrary attacker-chosen keys into the sealed store:
///   kc:sig:        Signal session/identity state
///   kc:sk:         group sender keys
///   kc:e2e-keypair the (legacy) ECDH keypair — exact key, no suffix
///   kc:e2e-pt:     E2E plaintext cache entries
///   kc:e2e-pt-index E2E plaintext cache FIFO index (exact key)
///   kc:tok:        token storage
///   kc:outbox      unsent-message outbox (holds optimistic plaintext)
const ALLOWED_KEY_PREFIXES: &[&str] = &["kc:sig:", "kc:sk:", "kc:e2e-pt:", "kc:tok:", "kc:outbox"];
const ALLOWED_EXACT_KEYS: &[&str] = &["kc:e2e-keypair", "kc:e2e-pt-index"];

/// True when `key` belongs to a known vault namespace.
fn is_allowed_key(key: &str) -> bool {
    ALLOWED_EXACT_KEYS.contains(&key) || ALLOWED_KEY_PREFIXES.iter().any(|p| key.starts_with(p))
}

pub struct VaultState {
    inner: Mutex<Vault>,
    master: [u8; 32],
    path: PathBuf,
}

impl VaultState {
    fn persist(&self, vault: &Vault) {
        if let Ok(blob) = vault.seal(&self.master) {
            let _ = std::fs::write(&self.path, blob);
        }
    }
}

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut k = [0u8; 32];
    for (i, slot) in k.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(k)
}

/// Master key from the OS keychain (created on first run). Falls back to an ephemeral
/// key if the keychain is unavailable — the vault then survives only this session.
fn load_or_create_master() -> [u8; 32] {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        if let Ok(pw) = entry.get_password() {
            if let Some(k) = from_hex(&pw) {
                return k;
            }
        }
        let mut k = [0u8; 32];
        rand::rng().fill_bytes(&mut k);
        let _ = entry.set_password(&to_hex(&k));
        return k;
    }
    let mut k = [0u8; 32];
    rand::rng().fill_bytes(&mut k);
    k
}

/// Load the vault on startup: keychain master key + decrypt the sealed blob (if any).
pub fn init(app: &AppHandle) {
    let master = load_or_create_master();
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(VAULT_FILE);
    let vault = match std::fs::read(&path) {
        Ok(blob) => Vault::open(&blob, &master).unwrap_or_else(|_| Vault::new()),
        Err(_) => Vault::new(),
    };
    app.manage(VaultState {
        inner: Mutex::new(vault),
        master,
        path,
    });
}

#[tauri::command]
pub fn vault_available() -> bool {
    true
}

/// All key→value pairs, to hydrate the webview's in-memory mirror once at startup.
#[tauri::command]
pub fn vault_snapshot(state: State<VaultState>) -> HashMap<String, String> {
    let v = state.inner.lock().unwrap();
    v.keys()
        .into_iter()
        .filter_map(|k| v.get(&k).map(|val| (k, val)))
        .collect()
}

#[tauri::command]
pub fn vault_set(state: State<VaultState>, key: String, value: String) -> Result<(), String> {
    if !is_allowed_key(&key) {
        return Err("vault_set: disallowed key namespace".to_string());
    }
    let mut v = state.inner.lock().unwrap();
    v.set(&key, &value).map_err(|e| e.to_string())?;
    state.persist(&v);
    Ok(())
}

#[tauri::command]
pub fn vault_remove(state: State<VaultState>, key: String) {
    let mut v = state.inner.lock().unwrap();
    v.remove(&key);
    state.persist(&v);
}

/// The dead-man's switch: wipe RAM, delete the sealed blob, destroy the keychain key.
#[tauri::command]
pub fn vault_burn(state: State<VaultState>) {
    let mut v = state.inner.lock().unwrap();
    v.wipe();
    let _ = std::fs::remove_file(&state.path);
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::is_allowed_key;

    #[test]
    fn vault_allowlist_includes_sensitive_cache_and_token_namespaces() {
        assert!(is_allowed_key("kc:sig:identityKey"));
        assert!(is_allowed_key("kc:sk:own:group"));
        assert!(is_allowed_key("kc:e2e-keypair"));
        assert!(is_allowed_key("kc:e2e-pt:message-id"));
        assert!(is_allowed_key("kc:e2e-pt-index"));
        assert!(is_allowed_key("kc:tok:home-id"));
        assert!(is_allowed_key("kc:outbox"));
    }

    #[test]
    fn vault_allowlist_rejects_unrelated_webview_storage() {
        assert!(!is_allowed_key("theme"));
        assert!(!is_allowed_key("kc:e2e-pt-index:evil-suffix"));
        assert!(!is_allowed_key("kc:profile-cache"));
    }
}
