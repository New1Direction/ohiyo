//! Tauri glue for the locked-RAM E2E key vault (dazai/goodnight-backed). Holds the
//! vault + a master key in the NATIVE process; persists only an AES-256-GCM **sealed**
//! blob to app data (never plaintext on disk); and exposes get/set/remove/burn to the
//! webview so the JS Signal + sender-key stores can live in locked RAM instead of
//! `localStorage`. The master key lives in the OS keychain. `vault_burn` is the
//! dead-man's switch: wipe RAM + delete the sealed blob + destroy the keychain key.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use kikka_vault::Vault;
use rand::RngCore;
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "kikkacord";
const KEYRING_ACCOUNT: &str = "vault-master";
const VAULT_FILE: &str = "kc-vault.bin";
const VAULT_TEMP_SUFFIX: &str = ".tmp";

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

/// Start of the error every vault command returns while the vault is locked. The webview
/// (`lib/vaultLock.ts`) matches it to show the locked state instead of starting empty.
const VAULT_LOCKED_PREFIX: &str = "vault_locked: ";

pub struct VaultState {
    path: PathBuf,
    /// The unlocked vault, or why it stayed locked. A locked vault never writes the sealed
    /// file, so a keychain or decrypt failure can't replace it with an empty one.
    vault: Result<UnlockedVault, String>,
}

struct UnlockedVault {
    inner: Mutex<Vault>,
    master: [u8; 32],
    /// Set by `vault_burn`: the master key is being destroyed, so nothing may be sealed
    /// under it again (the next launch would find a file no key can open).
    burned: AtomicBool,
}

impl VaultState {
    fn unlocked(&self) -> Result<&UnlockedVault, String> {
        self.vault
            .as_ref()
            .map_err(|reason| format!("{VAULT_LOCKED_PREFIX}{reason}"))
    }

    fn persist(&self, vault: &Vault) {
        let Ok(unlocked) = &self.vault else { return };
        if unlocked.burned.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(blob) = vault.seal(&unlocked.master) {
            let _ = write_atomically(&self.path, &blob);
        }
    }

    /// Wipe RAM, stop further writes, and delete the sealed file plus any temp file an
    /// interrupted write left behind.
    fn burn_local(&self) {
        let _guard = self.vault.as_ref().ok().map(|unlocked| {
            let mut v = unlocked.inner.lock().unwrap();
            unlocked.burned.store(true, Ordering::SeqCst);
            v.wipe();
            v
        });
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(temp_path(&self.path));
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(VAULT_TEMP_SUFFIX);
    PathBuf::from(name)
}

/// Replace `path` with `bytes` without ever leaving a partial file: write a temp file in
/// the same directory, fsync it, then rename it over `path`.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = temp_path(path);
    let written = File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path)
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

/// What to do about the master key, given what the keychain returned. Debug only in tests,
/// so the key bytes can't end up in a log.
#[cfg_attr(test, derive(Debug, PartialEq))]
enum MasterKey {
    Existing([u8; 32]),
    CreateNew,
    /// Don't create or store a key; the vault stays locked for this reason.
    Locked(String),
}

/// Only a "no entry" answer, on a first run with no sealed vault on disk, creates a new
/// key. Any other keychain error, a malformed stored key, or a missing key with a sealed
/// vault present leaves the vault locked: a new key could never open that file, and
/// using one would overwrite it.
fn decide_master_key(
    stored: Result<String, keyring::Error>,
    sealed_vault_exists: bool,
) -> MasterKey {
    match stored {
        Ok(hex) => match from_hex(&hex) {
            Some(k) => MasterKey::Existing(k),
            None => MasterKey::Locked("the vault key in the OS keychain is malformed".to_string()),
        },
        Err(keyring::Error::NoEntry) if !sealed_vault_exists => MasterKey::CreateNew,
        Err(keyring::Error::NoEntry) => MasterKey::Locked(
            "the OS keychain has no vault key, but a sealed vault exists".to_string(),
        ),
        Err(e) => MasterKey::Locked(format!("the OS keychain could not be read: {e}")),
    }
}

/// The vault from the sealed file's bytes. Only a missing file starts an empty vault; a
/// file that can't be read or decrypted keeps the vault locked.
fn open_sealed(read: io::Result<Vec<u8>>, master: &[u8; 32]) -> Result<Vault, String> {
    match read {
        Ok(blob) => Vault::open(&blob, master)
            .map_err(|e| format!("the sealed vault could not be opened: {e}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vault::new()),
        Err(e) => Err(format!("the sealed vault could not be read: {e}")),
    }
}

/// Unlock the sealed vault at `path` with the keychain master key (created on first run).
/// On any failure nothing is generated, stored or overwritten, and the reason is returned.
fn unlock(path: &Path) -> Result<UnlockedVault, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("the OS keychain is unavailable: {e}"))?;
    // If we can't tell whether a sealed vault exists, assume it does.
    let sealed_vault_exists = path.try_exists().unwrap_or(true);
    let master = match decide_master_key(entry.get_password(), sealed_vault_exists) {
        MasterKey::Existing(k) => k,
        MasterKey::CreateNew => {
            let mut k = [0u8; 32];
            rand::rng().fill_bytes(&mut k);
            entry.set_password(&to_hex(&k)).map_err(|e| {
                format!("a new vault key could not be saved to the OS keychain: {e}")
            })?;
            k
        }
        MasterKey::Locked(reason) => return Err(reason),
    };
    let vault = open_sealed(std::fs::read(path), &master)?;
    Ok(UnlockedVault {
        inner: Mutex::new(vault),
        master,
        burned: AtomicBool::new(false),
    })
}

/// Load the vault on startup: keychain master key + decrypt the sealed blob (if any).
/// If that fails the vault stays locked and every command reports why.
pub fn init(app: &AppHandle) {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(VAULT_FILE);
    let vault = unlock(&path);
    app.manage(VaultState { path, vault });
}

#[tauri::command]
pub fn vault_available() -> bool {
    true
}

/// All key→value pairs, to hydrate the webview's in-memory mirror once at startup.
#[tauri::command]
pub fn vault_snapshot(state: State<VaultState>) -> Result<HashMap<String, String>, String> {
    let v = state.unlocked()?.inner.lock().unwrap();
    Ok(v.keys()
        .into_iter()
        .filter_map(|k| v.get(&k).map(|val| (k, val)))
        .collect())
}

#[tauri::command]
pub fn vault_set(state: State<VaultState>, key: String, value: String) -> Result<(), String> {
    if !is_allowed_key(&key) {
        return Err("vault_set: disallowed key namespace".to_string());
    }
    let mut v = state.unlocked()?.inner.lock().unwrap();
    v.set(&key, &value).map_err(|e| e.to_string())?;
    state.persist(&v);
    Ok(())
}

#[tauri::command]
pub fn vault_remove(state: State<VaultState>, key: String) -> Result<(), String> {
    let mut v = state.unlocked()?.inner.lock().unwrap();
    v.remove(&key);
    state.persist(&v);
    Ok(())
}

/// The dead-man's switch: wipe RAM, delete the sealed blob, destroy the keychain key.
#[tauri::command]
pub fn vault_burn(state: State<VaultState>) {
    state.burn_local();
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    /// A fresh, empty directory under the system temp dir for one test.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ohiyo-vault-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn platform_failure() -> keyring::Error {
        keyring::Error::PlatformFailure("keychain is locked".into())
    }

    fn unlocked_state(path: PathBuf) -> VaultState {
        VaultState {
            path,
            vault: Ok(UnlockedVault {
                inner: Mutex::new(Vault::new()),
                master: KEY,
                burned: AtomicBool::new(false),
            }),
        }
    }

    fn set_and_persist(state: &VaultState, key: &str, value: &str) {
        let mut v = state.unlocked().unwrap().inner.lock().unwrap();
        v.set(key, value).unwrap();
        state.persist(&v);
    }

    #[test]
    fn stored_master_key_is_used() {
        assert_eq!(
            decide_master_key(Ok(to_hex(&KEY)), true),
            MasterKey::Existing(KEY)
        );
    }

    #[test]
    fn only_a_missing_keychain_entry_creates_a_master_key() {
        assert_eq!(
            decide_master_key(Err(keyring::Error::NoEntry), false),
            MasterKey::CreateNew
        );
    }

    #[test]
    fn keychain_errors_lock_the_vault_instead_of_creating_a_key() {
        for err in [
            platform_failure(),
            keyring::Error::NoStorageAccess("access denied".into()),
            keyring::Error::BadEncoding(vec![0xff]),
        ] {
            assert!(matches!(
                decide_master_key(Err(err), true),
                MasterKey::Locked(_)
            ));
        }
        assert!(matches!(
            decide_master_key(Err(platform_failure()), false),
            MasterKey::Locked(_)
        ));
    }

    #[test]
    fn malformed_keychain_value_locks_the_vault() {
        assert!(matches!(
            decide_master_key(Ok("not-a-hex-key".to_string()), true),
            MasterKey::Locked(_)
        ));
    }

    #[test]
    fn missing_entry_with_a_sealed_vault_on_disk_locks_instead_of_replacing_the_key() {
        assert!(matches!(
            decide_master_key(Err(keyring::Error::NoEntry), true),
            MasterKey::Locked(_)
        ));
    }

    #[test]
    fn missing_sealed_file_opens_an_empty_vault() {
        let read = Err(io::Error::from(io::ErrorKind::NotFound));
        assert!(open_sealed(read, &KEY).unwrap().is_empty());
    }

    #[test]
    fn sealed_file_opens_with_its_key() {
        let mut v = Vault::new();
        v.set("kc:sig:identityKey", "id").unwrap();
        let opened = open_sealed(Ok(v.seal(&KEY).unwrap()), &KEY).unwrap();
        assert_eq!(opened.get("kc:sig:identityKey").as_deref(), Some("id"));
    }

    #[test]
    fn sealed_file_that_does_not_open_stays_locked() {
        let mut v = Vault::new();
        v.set("kc:sig:identityKey", "id").unwrap();
        let blob = v.seal(&KEY).unwrap();
        assert!(open_sealed(Ok(blob), &[9u8; 32]).is_err());
        assert!(open_sealed(Ok(Vec::new()), &KEY).is_err());
    }

    #[test]
    fn unreadable_sealed_file_stays_locked() {
        let read = Err(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(open_sealed(read, &KEY).is_err());
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temp_file() {
        let dir = scratch_dir("atomic-replace");
        let path = dir.join(VAULT_FILE);
        std::fs::write(&path, b"old").unwrap();
        write_atomically(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!temp_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_goes_through_a_temp_file_and_keeps_the_old_file_on_failure() {
        let dir = scratch_dir("atomic-failure");
        let path = dir.join(VAULT_FILE);
        std::fs::write(&path, b"old").unwrap();
        // A directory where the temp file should go makes the temp write fail.
        std::fs::create_dir(temp_path(&path)).unwrap();
        assert!(write_atomically(&path, b"new").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_burned_vault_never_writes_the_sealed_file_again() {
        let dir = scratch_dir("burned");
        let state = unlocked_state(dir.join(VAULT_FILE));
        set_and_persist(&state, "kc:sig:identityKey", "id");
        assert!(state.path.exists());
        state.burn_local();
        assert!(!state.path.exists());
        // A write after the burn would seal under a master key that no longer exists.
        set_and_persist(&state, "kc:sig:identityKey", "id2");
        assert!(!state.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_locked_vault_reports_why_with_the_prefix_the_webview_matches() {
        let state = VaultState {
            path: PathBuf::from("unused"),
            vault: Err("the OS keychain could not be read: denied".to_string()),
        };
        assert_eq!(
            state.unlocked().err().as_deref(),
            Some("vault_locked: the OS keychain could not be read: denied")
        );
    }

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
