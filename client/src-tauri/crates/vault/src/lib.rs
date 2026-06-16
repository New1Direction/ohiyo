//! Locked-RAM key vault for Ohiyo's E2E key material.
//!
//! E2E private keys (Signal identity, ratchet state, sender keys) and the decrypted
//! plaintext cache normally live in the webview's `localStorage` — plaintext, on disk,
//! forever. This vault instead holds them in page-locked, non-swappable RAM
//! (`goodnight::SecretBuffer`) for the life of the session, persists them ONLY as an
//! AES-256-GCM blob (the master key lives in the OS keychain, never on disk in the
//! clear), and supports an explicit [`Vault::wipe`] BURN for the dead-man's switch.
//!
//! Faithful to dazai's "ephemeral, session-bound secrets" model. Honest limit: while a
//! key is in active use the webview still copies it into JS heap — the vault protects
//! it *at rest* (never on disk in clear) and *burns it on cue*, not in-use in the GC heap.

#![deny(unsafe_code)] // the only unsafe lives in the vendored `goodnight` crate

use std::collections::HashMap;
use std::io;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use goodnight::SecretBuffer;
use rand::RngCore;
use serde::{Deserialize, Serialize};

const NONCE_LEN: usize = 12;

#[derive(Debug)]
pub enum VaultError {
    Io(io::Error),
    /// AES-GCM auth/decrypt failure — wrong master key or a tampered blob.
    Crypto,
    /// Malformed sealed blob or JSON.
    Format,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Io(e) => write!(f, "vault io: {e}"),
            VaultError::Crypto => write!(f, "vault decrypt failed (wrong key or tampered)"),
            VaultError::Format => write!(f, "vault blob malformed"),
        }
    }
}
impl std::error::Error for VaultError {}
impl From<io::Error> for VaultError {
    fn from(e: io::Error) -> Self {
        VaultError::Io(e)
    }
}

/// A page-locked key→value store. Values are UTF-8 strings (the localStorage shape the
/// JS key stores use). Each value lives in its own `SecretBuffer`; the logical length
/// is tracked separately so empty strings round-trip (a `SecretBuffer` is never 0-len).
#[derive(Default)]
pub struct Vault {
    entries: HashMap<String, (SecretBuffer, usize)>,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    kv: HashMap<String, String>,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Store (or replace) a value in locked RAM.
    pub fn set(&mut self, key: &str, value: &str) -> io::Result<()> {
        let bytes = value.as_bytes();
        let mut buf = SecretBuffer::new(bytes.len().max(1))?;
        buf.write(bytes)?;
        self.entries.insert(key.to_owned(), (buf, bytes.len()));
        Ok(())
    }

    /// Read a value out of locked RAM (copied into a `String` for the caller).
    pub fn get(&self, key: &str) -> Option<String> {
        self.entries
            .get(key)
            .map(|(buf, n)| String::from_utf8_lossy(&buf.as_slice()[..*n]).into_owned())
    }

    /// Remove (and securely wipe) one entry.
    pub fn remove(&mut self, key: &str) {
        if let Some((mut buf, _)) = self.entries.remove(key) {
            buf.wipe();
        }
    }

    pub fn keys(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// BURN: securely wipe every buffer and drop all entries. The dead-man's switch.
    pub fn wipe(&mut self) {
        for (_, (buf, _)) in self.entries.iter_mut() {
            buf.wipe();
        }
        self.entries.clear();
    }

    /// Serialize + AES-256-GCM encrypt the whole vault under `master` (32 bytes). The
    /// returned blob is `nonce(12) || ciphertext` and is the ONLY thing that ever
    /// touches disk — useless without the keychain-held master key.
    pub fn seal(&self, master: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
        let kv: HashMap<String, String> = self
            .entries
            .iter()
            .map(|(k, (buf, n))| {
                (
                    k.clone(),
                    String::from_utf8_lossy(&buf.as_slice()[..*n]).into_owned(),
                )
            })
            .collect();
        let plaintext = serde_json::to_vec(&Sealed { kv }).map_err(|_| VaultError::Format)?;

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(master));
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
            .map_err(|_| VaultError::Crypto)?;

        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ct);
        Ok(blob)
    }

    /// Decrypt + load a sealed blob into a fresh locked-RAM vault. Fails (`Crypto`) if
    /// the master key is wrong or the blob was tampered with.
    pub fn open(blob: &[u8], master: &[u8; 32]) -> Result<Vault, VaultError> {
        if blob.len() < NONCE_LEN {
            return Err(VaultError::Format);
        }
        let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(master));
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ct)
            .map_err(|_| VaultError::Crypto)?;
        let sealed: Sealed = serde_json::from_slice(&plaintext).map_err(|_| VaultError::Format)?;

        let mut vault = Vault::new();
        for (k, v) in sealed.kv {
            vault.set(&k, &v)?;
        }
        Ok(vault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn set_get_remove_roundtrip() {
        let mut v = Vault::new();
        v.set("kc:sig:identityKey", "{\"t\":\"kp\"}").unwrap();
        v.set("kc:sk:own:g1", "chain").unwrap();
        assert_eq!(v.get("kc:sig:identityKey").as_deref(), Some("{\"t\":\"kp\"}"));
        assert_eq!(v.get("kc:sk:own:g1").as_deref(), Some("chain"));
        assert_eq!(v.get("missing"), None);
        v.remove("kc:sk:own:g1");
        assert_eq!(v.get("kc:sk:own:g1"), None);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn empty_value_roundtrips() {
        // senderKeys.resetGroup() stores "" — must survive (SecretBuffer is never 0-len).
        let mut v = Vault::new();
        v.set("kc:sk:own:g1", "").unwrap();
        assert_eq!(v.get("kc:sk:own:g1").as_deref(), Some(""));
    }

    #[test]
    fn wipe_clears_everything() {
        let mut v = Vault::new();
        v.set("a", "1").unwrap();
        v.set("b", "2").unwrap();
        v.wipe();
        assert!(v.is_empty());
        assert_eq!(v.get("a"), None);
    }

    #[test]
    fn seal_open_roundtrip() {
        let mut v = Vault::new();
        v.set("k1", "secret-identity").unwrap();
        v.set("k2", "ratchet-state").unwrap();
        v.set("empty", "").unwrap();
        let blob = v.seal(&KEY).unwrap();
        // the blob must not contain the plaintext
        assert!(!blob.windows(15).any(|w| w == b"secret-identity"));
        let reopened = Vault::open(&blob, &KEY).unwrap();
        assert_eq!(reopened.get("k1").as_deref(), Some("secret-identity"));
        assert_eq!(reopened.get("k2").as_deref(), Some("ratchet-state"));
        assert_eq!(reopened.get("empty").as_deref(), Some(""));
    }

    #[test]
    fn wrong_key_cannot_open() {
        let mut v = Vault::new();
        v.set("k1", "top-secret").unwrap();
        let blob = v.seal(&KEY).unwrap();
        let wrong = [9u8; 32];
        assert!(matches!(Vault::open(&blob, &wrong), Err(VaultError::Crypto)));
    }

    #[test]
    fn tampered_blob_rejected() {
        let mut v = Vault::new();
        v.set("k1", "top-secret").unwrap();
        let mut blob = v.seal(&KEY).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff; // flip a ciphertext byte
        assert!(matches!(Vault::open(&blob, &KEY), Err(VaultError::Crypto)));
    }
}
