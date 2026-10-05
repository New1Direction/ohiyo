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
use std::sync::{Mutex, OnceLock};

use kikka_vault::Vault;
use rand::RngCore;
use tauri::{AppHandle, Manager, State};

/// The keychain entry that holds the vault's master key. Every installed copy uses
/// "kikkacord"; changing it would lock people out of their saved keys. A test build can
/// be given its own entry at compile time (OHIYO_KEYRING_SERVICE), so trying a build on
/// a machine that also has the real app cannot touch the real app's key. The sealed vault
/// file is found by the app's identifier, so a test build needs its own identifier too.
const KEYRING_SERVICE: &str = match option_env!("OHIYO_KEYRING_SERVICE") {
    Some(service) => service,
    None => "kikkacord",
};
const KEYRING_ACCOUNT: &str = "vault-master";
const VAULT_FILE: &str = "kc-vault.bin";
const VAULT_TEMP_SUFFIX: &str = ".tmp";
/// Where a reset moves saved keys that can't be opened (kept, in case they can be opened
/// by hand later).
const VAULT_UNREADABLE_SUFFIX: &str = ".unreadable";

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

/// Start of the error every vault command returns while the vault is locked, followed by
/// the kind and the reason: `vault_locked: <keychain|vault>: <reason>`. The webview
/// (`lib/vaultLock.ts`) parses it to show the locked screen instead of starting empty.
const VAULT_LOCKED_PREFIX: &str = "vault_locked: ";

/// Why the vault stayed locked, which decides what the locked screen offers.
#[derive(Clone, Copy)]
#[cfg_attr(test, derive(Debug, PartialEq))]
enum LockKind {
    /// The keychain couldn't be reached or read, or a new key couldn't be saved. Retrying
    /// can help; a reset can't.
    Keychain,
    /// No key but a sealed vault exists, the stored key is malformed, or the sealed file
    /// can't be read or opened. The user may reset this device.
    Vault,
}

#[cfg_attr(test, derive(Debug, PartialEq))]
struct Locked {
    kind: LockKind,
    reason: String,
}

impl Locked {
    fn keychain(reason: impl Into<String>) -> Self {
        Self {
            kind: LockKind::Keychain,
            reason: reason.into(),
        }
    }

    fn vault(reason: impl Into<String>) -> Self {
        Self {
            kind: LockKind::Vault,
            reason: reason.into(),
        }
    }

    fn error(&self) -> String {
        let kind = match self.kind {
            LockKind::Keychain => "keychain",
            LockKind::Vault => "vault",
        };
        format!("{VAULT_LOCKED_PREFIX}{kind}: {}", self.reason)
    }
}

/// What a vault command returns while the unlock has not finished. Deliberately not a
/// `vault_locked` error: nothing is wrong yet, and the locked screen would offer a reset.
const VAULT_UNLOCKING: &str = "vault_unlocking: the saved keys are still being unlocked";

pub struct VaultState {
    path: PathBuf,
    /// The unlocked vault, or why it stayed locked. A locked vault never writes the sealed
    /// file, so a keychain or decrypt failure can't replace it with an empty one.
    ///
    /// Empty until the unlock has finished. Reading the keychain can wait on an OS password
    /// prompt for as long as the person takes to answer it, so the unlock never runs on the
    /// main thread (see `init`), and only `vault_snapshot` waits for it.
    vault: OnceLock<Result<UnlockedVault, Locked>>,
}

struct UnlockedVault {
    inner: Mutex<Vault>,
    master: [u8; 32],
    /// Set by `vault_burn`: the master key is being destroyed, so nothing may be sealed
    /// under it again (the next launch would find a file no key can open).
    burned: AtomicBool,
}

impl VaultState {
    /// The vault if the unlock has finished and worked. Never waits.
    fn unlocked(&self) -> Result<&UnlockedVault, String> {
        match self.vault.get() {
            Some(vault) => vault.as_ref().map_err(Locked::error),
            None => Err(VAULT_UNLOCKING.to_string()),
        }
    }

    /// Unlock on first use and return how it went. A second caller that arrives while the
    /// first is still waiting on the OS waits for the same answer; the key is asked for
    /// once. Call this off the main thread only.
    fn unlock_once(
        &self,
        unlock: impl FnOnce(&Path) -> Result<UnlockedVault, Locked>,
    ) -> &Result<UnlockedVault, Locked> {
        self.vault.get_or_init(|| unlock(&self.path))
    }

    fn persist(&self, vault: &Vault) {
        let Some(Ok(unlocked)) = self.vault.get() else {
            return;
        };
        if unlocked.burned.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(blob) = vault.seal(&unlocked.master) {
            let _ = write_atomically(&self.path, &blob);
        }
    }

    /// Remove every key, then seal and write the vault once. Each write fsyncs (a full
    /// flush on macOS), so removing thousands of keys one call at a time froze the app.
    fn remove_many(&self, keys: &[String]) -> Result<(), String> {
        let mut v = self.unlocked()?.inner.lock().unwrap();
        for key in keys {
            v.remove(key);
        }
        self.persist(&v);
        Ok(())
    }

    /// Wipe RAM, stop further writes, and delete the sealed file, any temp file an
    /// interrupted write left behind, and any file a reset moved aside. Returns how each
    /// deletion went.
    fn burn_local(&self) -> (io::Result<()>, io::Result<()>, io::Result<()>) {
        let _guard = self
            .vault
            .get()
            .and_then(|vault| vault.as_ref().ok())
            .map(|unlocked| {
                let mut v = unlocked.inner.lock().unwrap();
                unlocked.burned.store(true, Ordering::SeqCst);
                v.wipe();
                v
            });
        (
            std::fs::remove_file(&self.path),
            std::fs::remove_file(temp_path(&self.path)),
            std::fs::remove_file(unreadable_path(&self.path)),
        )
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(VAULT_TEMP_SUFFIX);
    PathBuf::from(name)
}

fn unreadable_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(VAULT_UNREADABLE_SUFFIX);
    PathBuf::from(name)
}

/// Reset, step 1: move the sealed file aside (replacing an earlier one) and drop any temp
/// file. A missing sealed file is fine. If the move fails, nothing else is changed.
fn move_sealed_aside(path: &Path) -> io::Result<()> {
    match std::fs::rename(path, unreadable_path(path)) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let _ = std::fs::remove_file(temp_path(path));
    Ok(())
}

/// Reset, step 2: what to do with the keychain entry.
#[cfg_attr(test, derive(Debug, PartialEq))]
enum KeychainReset {
    /// A well-formed key stays: the next launch starts an empty vault under it, and the
    /// moved file can still be opened with it by hand.
    Keep,
    /// A malformed key is useless; delete it so the next launch creates a new one.
    Delete,
    /// No entry: nothing to do.
    Nothing,
}

fn keychain_reset(stored: Result<String, keyring::Error>) -> Result<KeychainReset, String> {
    match stored {
        Ok(hex) if from_hex(&hex).is_some() => Ok(KeychainReset::Keep),
        Ok(_) => Ok(KeychainReset::Delete),
        Err(keyring::Error::NoEntry) => Ok(KeychainReset::Nothing),
        Err(e) => Err(format!("the OS keychain could not be read: {e}")),
    }
}

/// The sealed file a reset may move aside: only when the vault is locked on its saved
/// keys. A reset can't help when the keychain can't be reached, and must never touch a
/// vault that opened.
fn reset_target(state: &VaultState) -> Result<&Path, String> {
    match state.vault.get() {
        Some(Err(Locked {
            kind: LockKind::Vault,
            ..
        })) => Ok(&state.path),
        Some(Err(_)) => Err("a reset can't help: the OS keychain can't be reached".to_string()),
        Some(Ok(_)) => Err("the vault isn't locked".to_string()),
        None => Err(VAULT_UNLOCKING.to_string()),
    }
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
    Locked(Locked),
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
            None => MasterKey::Locked(Locked::vault(
                "the vault key in the OS keychain is malformed",
            )),
        },
        Err(keyring::Error::NoEntry) if !sealed_vault_exists => MasterKey::CreateNew,
        Err(keyring::Error::NoEntry) => MasterKey::Locked(Locked::vault(
            "the OS keychain has no vault key, but a sealed vault exists",
        )),
        Err(e) => MasterKey::Locked(Locked::keychain(format!(
            "the OS keychain could not be read: {e}"
        ))),
    }
}

/// The vault from the sealed file's bytes. Only a missing file starts an empty vault; a
/// file that can't be read or decrypted keeps the vault locked.
fn open_sealed(read: io::Result<Vec<u8>>, master: &[u8; 32]) -> Result<Vault, Locked> {
    match read {
        Ok(blob) => Vault::open(&blob, master)
            .map_err(|e| Locked::vault(format!("the sealed vault could not be opened: {e}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vault::new()),
        Err(e) => Err(Locked::vault(format!(
            "the sealed vault could not be read: {e}"
        ))),
    }
}

/// Unlock the sealed vault at `path` with the keychain master key (created on first run).
/// On any failure nothing is generated, stored or overwritten, and the reason is returned.
fn unlock(path: &Path) -> Result<UnlockedVault, Locked> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| Locked::keychain(format!("the OS keychain is unavailable: {e}")))?;
    // If we can't tell whether a sealed vault exists, assume it does.
    let sealed_vault_exists = path.try_exists().unwrap_or(true);
    let master = match decide_master_key(entry.get_password(), sealed_vault_exists) {
        MasterKey::Existing(k) => k,
        MasterKey::CreateNew => {
            let mut k = [0u8; 32];
            rand::rng().fill_bytes(&mut k);
            entry.set_password(&to_hex(&k)).map_err(|e| {
                Locked::keychain(format!(
                    "a new vault key could not be saved to the OS keychain: {e}"
                ))
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
///
/// The unlock gets its own thread. When the OS decides to ask for a password first (macOS
/// does for a copy of the app it has not seen read this key), the read does not return
/// until the person answers. Done here on the main thread, that left the app frozen with
/// a white, unpainted window behind the prompt.
pub fn init(app: &AppHandle) {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(VAULT_FILE);
    app.manage(VaultState {
        path,
        vault: OnceLock::new(),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        app.state::<VaultState>().unlock_once(unlock);
    });
}

#[tauri::command]
pub fn vault_available() -> bool {
    true
}

/// All key→value pairs, to hydrate the webview's in-memory mirror once at startup. The
/// webview calls this first and nothing else until it returns, so this is the one command
/// that waits for the unlock. It must stay `async` (run off the main thread): a plain
/// command would do that waiting on the main thread and freeze the window.
#[tauri::command(async)]
pub fn vault_snapshot(state: State<VaultState>) -> Result<HashMap<String, String>, String> {
    let unlocked = state.unlock_once(unlock).as_ref().map_err(Locked::error)?;
    let v = unlocked.inner.lock().unwrap();
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

/// Remove many keys with one write (logout cleanup, the plaintext-cache expiry sweep).
/// Synchronous like the other commands, so writes keep their call order.
#[tauri::command]
pub fn vault_remove_many(state: State<VaultState>, keys: Vec<String>) -> Result<(), String> {
    state.remove_many(&keys)
}

/// "Reset this device" on the locked screen, only when the saved keys can't be opened:
/// move the sealed file aside, then delete the keychain key only if it is malformed. On
/// success the webview restarts the app, which then starts an empty vault.
#[tauri::command]
pub fn vault_reset(state: State<VaultState>) -> Result<(), String> {
    let path = reset_target(&state)?;
    move_sealed_aside(path).map_err(|e| format!("the saved keys could not be moved aside: {e}"))?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("the OS keychain is unavailable: {e}"))?;
    match keychain_reset(entry.get_password())? {
        KeychainReset::Delete => entry
            .delete_credential()
            .map_err(|e| format!("the malformed keychain key could not be deleted: {e}")),
        KeychainReset::Keep | KeychainReset::Nothing => Ok(()),
    }
}

/// A burn's result: Ok when the sealed file, the temp file, the moved-aside file and the
/// keychain key are all gone ("not found" counts as gone), else an error naming what is
/// still there.
fn burn_outcome(
    file: io::Result<()>,
    temp: io::Result<()>,
    aside: io::Result<()>,
    key: Result<(), keyring::Error>,
) -> Result<(), String> {
    let mut failed = Vec::new();
    for (what, deleted) in [
        ("the sealed vault file", file),
        ("the vault temp file", temp),
        ("the moved-aside vault file", aside),
    ] {
        if let Err(e) = deleted {
            if e.kind() != io::ErrorKind::NotFound {
                failed.push(format!("{what} ({e})"));
            }
        }
    }
    match key {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => failed.push(format!("the keychain key ({e})")),
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("couldn't delete {}", failed.join(", ")))
    }
}

/// The dead-man's switch: wipe RAM and try to delete the vault files and the keychain key,
/// reporting anything that couldn't be deleted. On success the webview restarts.
#[tauri::command]
pub fn vault_burn(state: State<VaultState>) -> Result<(), String> {
    let (file, temp, aside) = state.burn_local();
    let key = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .and_then(|entry| entry.delete_credential());
    burn_outcome(file, temp, aside, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn a_normal_build_keeps_the_keychain_entry_installed_copies_use() {
        match option_env!("OHIYO_KEYRING_SERVICE") {
            // Changing this name would lock everyone out of their saved keys. CI and
            // release builds never set OHIYO_KEYRING_SERVICE.
            None => assert_eq!(KEYRING_SERVICE, "kikkacord"),
            // A test build asked for its own entry and must get exactly that one.
            Some(own) => assert_eq!(KEYRING_SERVICE, own),
        }
        assert!(!KEYRING_SERVICE.is_empty());
    }

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
            vault: OnceLock::from(Ok(unlocked_vault())),
        }
    }

    fn unlocked_vault() -> UnlockedVault {
        UnlockedVault {
            inner: Mutex::new(Vault::new()),
            master: KEY,
            burned: AtomicBool::new(false),
        }
    }

    /// A state whose unlock has not finished: the OS is still being asked for the key.
    fn pending_state(path: PathBuf) -> VaultState {
        VaultState {
            path,
            vault: OnceLock::new(),
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
                MasterKey::Locked(Locked {
                    kind: LockKind::Keychain,
                    ..
                })
            ));
        }
        assert!(matches!(
            decide_master_key(Err(platform_failure()), false),
            MasterKey::Locked(Locked {
                kind: LockKind::Keychain,
                ..
            })
        ));
    }

    #[test]
    fn malformed_keychain_value_locks_the_vault() {
        assert!(matches!(
            decide_master_key(Ok("not-a-hex-key".to_string()), true),
            MasterKey::Locked(Locked {
                kind: LockKind::Vault,
                ..
            })
        ));
    }

    #[test]
    fn missing_entry_with_a_sealed_vault_on_disk_locks_instead_of_replacing_the_key() {
        assert!(matches!(
            decide_master_key(Err(keyring::Error::NoEntry), true),
            MasterKey::Locked(Locked {
                kind: LockKind::Vault,
                ..
            })
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
        assert!(is_vault_locked(open_sealed(Ok(blob), &[9u8; 32])));
        assert!(is_vault_locked(open_sealed(Ok(Vec::new()), &KEY)));
    }

    #[test]
    fn unreadable_sealed_file_stays_locked() {
        let read = Err(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(is_vault_locked(open_sealed(read, &KEY)));
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
        let (file, temp, aside) = state.burn_local();
        assert!(file.is_ok() && temp.is_err() && aside.is_err());
        assert!(!state.path.exists());
        // A write after the burn would seal under a master key that no longer exists.
        set_and_persist(&state, "kc:sig:identityKey", "id2");
        assert!(!state.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn denied() -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    fn not_found() -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }

    #[test]
    fn a_burn_also_deletes_the_vault_file_a_reset_moved_aside() {
        let dir = scratch_dir("burn-aside");
        let state = unlocked_state(dir.join(VAULT_FILE));
        std::fs::write(unreadable_path(&state.path), b"moved aside").unwrap();
        let (_, _, aside) = state.burn_local();
        assert!(aside.is_ok());
        assert!(!unreadable_path(&state.path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn burn_succeeds_when_everything_is_gone_even_if_it_was_never_there() {
        assert_eq!(burn_outcome(Ok(()), Ok(()), Ok(()), Ok(())), Ok(()));
        assert_eq!(
            burn_outcome(
                not_found(),
                not_found(),
                not_found(),
                Err(keyring::Error::NoEntry)
            ),
            Ok(())
        );
    }

    #[test]
    fn burn_names_what_it_could_not_delete() {
        let file = burn_outcome(denied(), Ok(()), Ok(()), Ok(())).unwrap_err();
        assert!(file.contains("the sealed vault file"), "{file}");
        assert!(!file.contains("keychain"), "{file}");
        let aside = burn_outcome(Ok(()), Ok(()), denied(), Ok(())).unwrap_err();
        assert!(aside.contains("the moved-aside vault file"), "{aside}");
        let key = burn_outcome(Ok(()), Ok(()), Ok(()), Err(platform_failure())).unwrap_err();
        assert!(key.contains("the keychain key"), "{key}");
        let all = burn_outcome(denied(), denied(), denied(), Err(platform_failure())).unwrap_err();
        for what in [
            "the sealed vault file",
            "the vault temp file",
            "the moved-aside vault file",
            "the keychain key",
        ] {
            assert!(all.contains(what), "{all}");
        }
    }

    #[test]
    fn batch_removal_drops_every_key_from_the_sealed_file() {
        let dir = scratch_dir("remove-many");
        let state = unlocked_state(dir.join(VAULT_FILE));
        set_and_persist(&state, "kc:e2e-pt:m1", "one");
        set_and_persist(&state, "kc:e2e-pt:m2", "two");
        set_and_persist(&state, "kc:sig:identityKey", "id");
        let keys = ["kc:e2e-pt:m1".to_string(), "kc:e2e-pt:m2".to_string()];
        state.remove_many(&keys).unwrap();
        let sealed = Vault::open(&std::fs::read(&state.path).unwrap(), &KEY).unwrap();
        assert_eq!(sealed.keys(), vec!["kc:sig:identityKey".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_removal_on_a_locked_vault_reports_it_locked() {
        let state = VaultState {
            path: PathBuf::from("unused"),
            vault: OnceLock::from(Err(Locked::keychain(
                "the OS keychain could not be read: denied",
            ))),
        };
        let err = state.remove_many(&["kc:outbox".to_string()]).unwrap_err();
        assert!(err.starts_with(VAULT_LOCKED_PREFIX), "{err}");
    }

    #[test]
    fn a_locked_vault_reports_its_kind_and_why_in_the_form_the_webview_parses() {
        let keychain = VaultState {
            path: PathBuf::from("unused"),
            vault: OnceLock::from(Err(Locked::keychain(
                "the OS keychain could not be read: denied",
            ))),
        };
        assert_eq!(
            keychain.unlocked().err().as_deref(),
            Some("vault_locked: keychain: the OS keychain could not be read: denied")
        );
        let vault = VaultState {
            path: PathBuf::from("unused"),
            vault: OnceLock::from(Err(Locked::vault("the sealed vault could not be opened"))),
        };
        assert_eq!(
            vault.unlocked().err().as_deref(),
            Some("vault_locked: vault: the sealed vault could not be opened")
        );
    }

    fn is_vault_locked(opened: Result<Vault, Locked>) -> bool {
        matches!(
            opened,
            Err(Locked {
                kind: LockKind::Vault,
                ..
            })
        )
    }

    #[test]
    fn reset_keeps_a_good_key_deletes_a_malformed_one_and_needs_a_readable_keychain() {
        assert_eq!(keychain_reset(Ok(to_hex(&KEY))), Ok(KeychainReset::Keep));
        assert_eq!(
            keychain_reset(Ok("not-a-hex-key".to_string())),
            Ok(KeychainReset::Delete)
        );
        assert_eq!(
            keychain_reset(Err(keyring::Error::NoEntry)),
            Ok(KeychainReset::Nothing)
        );
        assert!(keychain_reset(Err(platform_failure())).is_err());
    }

    #[test]
    fn reset_moves_the_sealed_file_aside_replacing_an_earlier_one() {
        let dir = scratch_dir("move-aside");
        let path = dir.join(VAULT_FILE);
        std::fs::write(&path, b"sealed").unwrap();
        std::fs::write(unreadable_path(&path), b"earlier").unwrap();
        std::fs::write(temp_path(&path), b"partial").unwrap();
        move_sealed_aside(&path).unwrap();
        assert!(!path.exists());
        assert!(!temp_path(&path).exists());
        assert_eq!(std::fs::read(unreadable_path(&path)).unwrap(), b"sealed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_with_no_sealed_file_is_fine() {
        let dir = scratch_dir("move-aside-missing");
        assert!(move_sealed_aside(&dir.join(VAULT_FILE)).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_move_changes_nothing() {
        let dir = scratch_dir("move-aside-fails");
        let path = dir.join(VAULT_FILE);
        std::fs::write(&path, b"sealed").unwrap();
        std::fs::write(temp_path(&path), b"partial").unwrap();
        // A non-empty directory where the moved file should go makes the move fail.
        std::fs::create_dir(unreadable_path(&path)).unwrap();
        std::fs::write(unreadable_path(&path).join("x"), b"x").unwrap();
        assert!(move_sealed_aside(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"sealed");
        assert!(temp_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_is_only_for_a_vault_that_is_locked_on_its_saved_keys() {
        let at = |vault| VaultState {
            path: PathBuf::from("kc-vault.bin"),
            vault: OnceLock::from(vault),
        };
        assert!(reset_target(&at(Err(Locked::vault("could not be opened")))).is_ok());
        assert!(reset_target(&at(Err(Locked::keychain("denied")))).is_err());
        assert!(reset_target(&unlocked_state(PathBuf::from("kc-vault.bin"))).is_err());
    }

    #[test]
    fn while_the_os_is_still_being_asked_for_the_key_nothing_waits_and_nothing_is_written() {
        // The unlock can sit behind an OS password prompt for as long as the person takes
        // to answer. These calls run on the main thread: if one waited there, the window
        // would freeze unpainted, which is how a launch came to show only a white window.
        let dir = scratch_dir("pending");
        let state = pending_state(dir.join(VAULT_FILE));
        assert_eq!(state.unlocked().err().as_deref(), Some(VAULT_UNLOCKING));
        assert_eq!(
            state
                .remove_many(&["kc:outbox".to_string()])
                .err()
                .as_deref(),
            Some(VAULT_UNLOCKING)
        );
        assert_eq!(reset_target(&state).err().as_deref(), Some(VAULT_UNLOCKING));
        state.persist(&Vault::new());
        assert!(!state.path.exists());
        // "Still unlocking" must not read as "locked": the locked screen offers a reset.
        assert!(!VAULT_UNLOCKING.starts_with(VAULT_LOCKED_PREFIX));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_key_is_asked_for_once_and_everyone_waiting_gets_that_answer() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::{mpsc, Arc};

        let state = Arc::new(pending_state(PathBuf::from("unused")));
        let asked = Arc::new(AtomicUsize::new(0));
        let (asking, is_asking) = mpsc::channel();
        let (answer, answered) = mpsc::channel::<()>();

        // The launch thread asks and is held up, as if a password prompt were on screen.
        let launch = {
            let (state, asked) = (Arc::clone(&state), Arc::clone(&asked));
            std::thread::spawn(move || {
                state
                    .unlock_once(|_| {
                        asked.fetch_add(1, Ordering::SeqCst);
                        asking.send(()).unwrap();
                        answered.recv().unwrap();
                        Err(Locked::keychain(
                            "the OS keychain could not be read: denied",
                        ))
                    })
                    .is_err()
            })
        };
        is_asking.recv().unwrap();
        // Meanwhile the main thread is told so at once.
        assert_eq!(state.unlocked().err().as_deref(), Some(VAULT_UNLOCKING));
        // The webview's snapshot arrives while the prompt is still up. It must wait for
        // that answer, not ask the keychain a second time (a second prompt).
        let snapshot = {
            let (state, asked) = (Arc::clone(&state), Arc::clone(&asked));
            std::thread::spawn(move || {
                state
                    .unlock_once(|_| {
                        asked.fetch_add(1, Ordering::SeqCst);
                        Ok(unlocked_vault())
                    })
                    .is_err()
            })
        };
        answer.send(()).unwrap();
        assert!(launch.join().unwrap());
        assert!(snapshot.join().unwrap(), "the snapshot used its own answer");
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        let err = state.unlocked().err().unwrap();
        assert!(err.starts_with(VAULT_LOCKED_PREFIX), "{err}");
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
