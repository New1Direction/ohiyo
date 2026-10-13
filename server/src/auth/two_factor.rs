//! Two-factor sign-in with an authenticator app (TOTP, RFC 6238), and the single-use
//! recovery codes that stand in for the app when it's lost.
//!
//! The shared secret is stored encrypted (AES-256-GCM, the user id as associated data, so a
//! row can't be moved to another account), under a key derived with HKDF-SHA256 from
//! `OHIYO_TOTP_KEY`, or from `JWT_SECRET` when that isn't set. With neither (or with only
//! the throwaway secret a dev server makes up at boot), [`SecretBox::from_env`] is `None` and
//! two-factor sign-in can't be turned on, rather than keeping secrets in plaintext.
//!
//! Recovery codes are 80 random bits each and stored as SHA-256 of the user id and the code,
//! so a copy of the database doesn't give them away and they keep working even if the
//! encryption key is replaced.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;
use sha2::{Digest, Sha256};

/// Digits in a code.
pub const DIGITS: u32 = 6;
/// Seconds each code lasts.
pub const STEP_SECS: i64 = 30;
/// Bytes of shared secret (160 bits, the size RFC 4226 recommends for HMAC-SHA1).
pub const SECRET_BYTES: usize = 20;
/// Recovery codes made at a time.
pub const RECOVERY_CODES: usize = 10;
/// Characters in a recovery code, without its dashes: 16 base32 characters, 80 bits.
const RECOVERY_CHARS: usize = 16;
/// What a server running without its own key derives the encryption key from.
pub const KEY_ENV: &str = "OHIYO_TOTP_KEY";
/// Set by `validate_config` when it made up a throwaway `JWT_SECRET` for a dev server; a key
/// derived from that would be gone after the next restart.
pub const JWT_GENERATED_ENV: &str = "OHIYO_JWT_SECRET_GENERATED";
/// The shortest key accepted, from either variable.
const MIN_KEY_LEN: usize = 32;
/// HKDF info, so this key is never the same as anything else derived from the same secret.
const HKDF_INFO: &[u8] = b"ohiyo two-factor secrets v1";
const NONCE_BYTES: usize = 12;

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32 without padding (what authenticator apps expect in an otpauth URL).
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decode base32, ignoring case, spaces, dashes and padding. `None` for anything else.
pub fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in input.chars() {
        if c == '=' || c == ' ' || c == '-' {
            continue;
        }
        let upper = c.to_ascii_uppercase();
        let value = BASE32.iter().position(|&b| b as char == upper)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// A new shared secret from the OS random generator.
pub fn generate_secret() -> Vec<u8> {
    let mut secret = vec![0u8; SECRET_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    secret
}

/// RFC 4226 HOTP before reducing to digits: the 31-bit dynamically truncated HMAC-SHA1.
pub fn hotp_raw(secret: &[u8], counter: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC accepts a key of any length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3])
}

/// The time step a moment falls in.
pub fn step_at(unix: i64) -> i64 {
    unix.div_euclid(STEP_SECS)
}

/// The six-digit code for a time step, with its leading zeros.
pub fn code_for_step(secret: &[u8], step: i64) -> String {
    let value = hotp_raw(secret, step.max(0) as u64) % 10u32.pow(DIGITS);
    format!("{value:0width$}", width = DIGITS as usize)
}

/// The six-digit code at a moment (what an authenticator app shows then).
pub fn totp_code(secret: &[u8], unix: i64) -> String {
    code_for_step(secret, step_at(unix))
}

/// Compare without stopping at the first difference.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The step a typed code belongs to: the current one or one either side (a phone's clock
/// may be a little off), and newer than `last_step`, so a code that already signed someone
/// in can't be used again. Spaces in the typed code are ignored.
pub fn verify_code(secret: &[u8], typed: &str, unix: i64, last_step: i64) -> Option<i64> {
    let digits: String = typed.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.len() != DIGITS as usize || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let now = step_at(unix);
    let mut matched = None;
    // Check all three steps whatever happens, so the time taken doesn't say which matched.
    for step in [now - 1, now, now + 1] {
        let expected = code_for_step(secret, step);
        if constant_time_eq(expected.as_bytes(), digits.as_bytes()) && step > last_step {
            matched = Some(step);
        }
    }
    matched
}

/// The link an authenticator app reads from the QR code.
pub fn otpauth_url(secret: &[u8], account: &str, issuer: &str) -> String {
    let label = format!("{}:{}", issuer, account);
    format!(
        "otpauth://totp/{}?secret={}&issuer={}&algorithm=SHA1&digits={}&period={}",
        urlencoding::encode(&label),
        base32_encode(secret),
        urlencoding::encode(issuer),
        DIGITS,
        STEP_SECS
    )
}

/// New recovery codes, shown as `XXXX-XXXX-XXXX-XXXX`.
pub fn generate_recovery_codes() -> Vec<String> {
    let mut rng = rand::rngs::OsRng;
    (0..RECOVERY_CODES)
        .map(|_| {
            let mut bytes = [0u8; 10];
            rng.fill_bytes(&mut bytes);
            let plain = base32_encode(&bytes);
            plain
                .as_bytes()
                .chunks(4)
                .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("-")
        })
        .collect()
}

/// A typed recovery code in the form it's hashed in: upper case, no spaces or dashes.
/// `None` when it can't be one.
pub fn normalize_recovery_code(typed: &str) -> Option<String> {
    let cleaned: String = typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if cleaned.len() != RECOVERY_CHARS || !cleaned.bytes().all(|b| BASE32.contains(&b)) {
        return None;
    }
    Some(cleaned)
}

/// What's stored for a recovery code: SHA-256 of the user id and the code, in hex.
pub fn hash_recovery_code(user_id: &str, normalized: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ohiyo recovery code v1\0");
    hasher.update(user_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Encrypts and decrypts two-factor secrets. The key never leaves it, and its `Debug` says
/// nothing about it.
#[derive(Clone)]
pub struct SecretBox {
    key: [u8; 32],
}

impl std::fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretBox(..)")
    }
}

impl SecretBox {
    /// A box keyed by HKDF-SHA256 of `master`.
    pub fn new(master: &[u8]) -> Self {
        let hk = hkdf::Hkdf::<Sha256>::new(None, master);
        let mut key = [0u8; 32];
        hk.expand(HKDF_INFO, &mut key)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        SecretBox { key }
    }

    /// The box this server uses: `OHIYO_TOTP_KEY` if set, else `JWT_SECRET` unless it was made
    /// up at boot. `None` (two-factor sign-in unavailable) when neither will do.
    pub fn from_env() -> Option<Self> {
        Self::from_values(
            std::env::var(KEY_ENV).ok().as_deref(),
            std::env::var("JWT_SECRET").ok().as_deref(),
            std::env::var(JWT_GENERATED_ENV).is_ok(),
        )
    }

    /// [`SecretBox::from_env`] on given values, so the choice can be tested.
    pub fn from_values(
        own_key: Option<&str>,
        jwt: Option<&str>,
        jwt_generated: bool,
    ) -> Option<Self> {
        if let Some(key) = own_key.map(str::trim).filter(|k| !k.is_empty()) {
            // A key that's set but too short is a mistake, not a reason to fall back silently.
            return (key.len() >= MIN_KEY_LEN).then(|| Self::new(key.as_bytes()));
        }
        let jwt = jwt.map(str::trim).filter(|j| j.len() >= MIN_KEY_LEN)?;
        if jwt_generated {
            return None;
        }
        Some(Self::new(jwt.as_bytes()))
    }

    /// Nonce followed by ciphertext. The user id is bound in as associated data.
    pub fn seal(&self, user_id: &str, plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).expect("a 32-byte key");
        let mut nonce = [0u8; NONCE_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: user_id.as_bytes(),
                },
            )
            .expect("AES-GCM encryption of a short secret can't fail");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&sealed);
        out
    }

    /// The plaintext, or `None` if the blob was changed, made for another user, or sealed
    /// under another key.
    pub fn open(&self, user_id: &str, blob: &[u8]) -> Option<Vec<u8>> {
        if blob.len() <= NONCE_BYTES {
            return None;
        }
        let (nonce, sealed) = blob.split_at(NONCE_BYTES);
        let cipher = Aes256Gcm::new_from_slice(&self.key).ok()?;
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: user_id.as_bytes(),
                },
            )
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn hotp_matches_the_rfc_4226_test_values() {
        let expected = [
            755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489,
        ];
        for (counter, want) in expected.iter().enumerate() {
            assert_eq!(
                hotp_raw(RFC_SECRET, counter as u64) % 1_000_000,
                *want,
                "counter {counter}"
            );
        }
    }

    #[test]
    fn totp_matches_the_rfc_6238_sha1_test_values() {
        // (time, 8-digit TOTP) from RFC 6238 appendix B, SHA1.
        let cases: [(i64, u32); 6] = [
            (59, 94287082),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
            (20000000000, 65353130),
        ];
        for (time, want) in cases {
            let raw = hotp_raw(RFC_SECRET, step_at(time) as u64);
            assert_eq!(raw % 100_000_000, want, "time {time}");
            assert_eq!(
                totp_code(RFC_SECRET, time),
                format!("{:06}", want % 1_000_000)
            );
        }
    }

    #[test]
    fn base32_matches_the_rfc_4648_test_values() {
        let cases = [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(base32_encode(plain.as_bytes()), encoded);
            assert_eq!(base32_decode(encoded).unwrap(), plain.as_bytes());
            assert_eq!(
                base32_decode(&encoded.to_lowercase()).unwrap(),
                plain.as_bytes()
            );
        }
        assert_eq!(base32_decode("MZXW6YQ=").unwrap(), b"foob");
        assert!(base32_decode("not base32!").is_none());
    }

    #[test]
    fn a_code_is_accepted_one_step_either_side_and_only_once() {
        let secret = generate_secret();
        let now = 1_700_000_015; // well inside a step
        let step = step_at(now);
        assert_eq!(
            verify_code(&secret, &totp_code(&secret, now), now, 0),
            Some(step)
        );
        assert_eq!(
            verify_code(&secret, &code_for_step(&secret, step - 1), now, 0),
            Some(step - 1)
        );
        assert_eq!(
            verify_code(&secret, &code_for_step(&secret, step + 1), now, 0),
            Some(step + 1)
        );
        assert_eq!(
            verify_code(&secret, &code_for_step(&secret, step - 2), now, 0),
            None
        );
        assert_eq!(
            verify_code(&secret, &code_for_step(&secret, step + 2), now, 0),
            None
        );
        // A code from a step that already signed someone in, or an older one, is refused.
        assert_eq!(
            verify_code(&secret, &totp_code(&secret, now), now, step),
            None
        );
        assert_eq!(
            verify_code(&secret, &code_for_step(&secret, step - 1), now, step - 1),
            None
        );
        // Spaces are fine; letters, short codes and long ones aren't.
        let spaced = totp_code(&secret, now);
        let spaced = format!("{} {}", &spaced[..3], &spaced[3..]);
        assert_eq!(verify_code(&secret, &spaced, now, 0), Some(step));
        assert_eq!(verify_code(&secret, "12345", now, 0), None);
        assert_eq!(verify_code(&secret, "1234567", now, 0), None);
        assert_eq!(verify_code(&secret, "12a456", now, 0), None);
    }

    #[test]
    fn the_otpauth_url_names_the_account_and_the_secret() {
        let url = otpauth_url(b"foobar", "alice", "Ohiyo");
        assert_eq!(
            url,
            "otpauth://totp/Ohiyo%3Aalice?secret=MZXW6YTBOI&issuer=Ohiyo&algorithm=SHA1&digits=6&period=30"
        );
    }

    #[test]
    fn recovery_codes_are_long_unique_and_read_back_however_they_are_typed() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODES);
        let unique: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), RECOVERY_CODES);
        for code in &codes {
            assert_eq!(code.len(), 19, "{code}");
            assert_eq!(code.matches('-').count(), 3, "{code}");
            let normal = normalize_recovery_code(code).unwrap();
            assert_eq!(
                normalize_recovery_code(&code.to_lowercase()).as_deref(),
                Some(normal.as_str())
            );
            assert_eq!(
                normalize_recovery_code(&code.replace('-', " ")).as_deref(),
                Some(normal.as_str())
            );
        }
        assert!(normalize_recovery_code("ABCD-EFGH").is_none());
        assert!(
            normalize_recovery_code("ABCD-EFGH-IJKL-MN01").is_none(),
            "0 and 1 aren't base32"
        );
        // The hash depends on the account, so the same code means nothing for someone else.
        let n = normalize_recovery_code(&codes[0]).unwrap();
        assert_ne!(hash_recovery_code("u1", &n), hash_recovery_code("u2", &n));
        assert_eq!(hash_recovery_code("u1", &n), hash_recovery_code("u1", &n));
    }

    #[test]
    fn a_sealed_secret_opens_only_for_its_account_and_key() {
        let sealed_box = SecretBox::new(b"a-test-master-key-that-is-long-enough");
        let secret = generate_secret();
        let blob = sealed_box.seal("user-1", &secret);
        assert!(
            !blob.windows(secret.len()).any(|w| w == secret.as_slice()),
            "the secret isn't stored as it is"
        );
        assert_eq!(sealed_box.open("user-1", &blob).unwrap(), secret);
        assert!(
            sealed_box.open("user-2", &blob).is_none(),
            "another account's row"
        );
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(
            sealed_box.open("user-1", &tampered).is_none(),
            "a changed blob"
        );
        let other_key = SecretBox::new(b"another-master-key-that-is-long-enough!");
        assert!(other_key.open("user-1", &blob).is_none(), "another key");
        // Two seals of the same secret differ (a fresh nonce each time).
        assert_ne!(sealed_box.seal("user-1", &secret), blob);
    }

    #[test]
    fn the_key_comes_from_its_own_variable_or_a_real_jwt_secret_and_never_a_made_up_one() {
        let long = "k".repeat(40);
        assert!(SecretBox::from_values(Some(&long), None, false).is_some());
        assert!(
            SecretBox::from_values(Some("short"), Some(&long), false).is_none(),
            "a short own key is a mistake"
        );
        assert!(SecretBox::from_values(None, Some(&long), false).is_some());
        assert!(
            SecretBox::from_values(None, Some(&long), true).is_none(),
            "a JWT secret made up at boot"
        );
        assert!(SecretBox::from_values(None, Some("short"), false).is_none());
        assert!(SecretBox::from_values(None, None, false).is_none());
        // The own key wins, and a JWT secret made up at boot doesn't matter then.
        let own = SecretBox::from_values(Some(&long), Some(&"j".repeat(40)), true).unwrap();
        let blob = own.seal("u", b"x");
        assert!(SecretBox::new(long.as_bytes()).open("u", &blob).is_some());
    }

    #[test]
    fn the_box_does_not_show_its_key() {
        assert_eq!(
            format!(
                "{:?}",
                SecretBox::new(b"whatever-key-material-here-0123456789")
            ),
            "SecretBox(..)"
        );
    }
}
