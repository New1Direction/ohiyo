//! Two-factor sign-in with an authenticator app (TOTP, RFC 6238). Stub: the tests that
//! describe it come first.

pub const DIGITS: u32 = 6;
pub const STEP_SECS: i64 = 30;
pub const SECRET_BYTES: usize = 20;
pub const RECOVERY_CODES: usize = 10;
pub const KEY_ENV: &str = "OHIYO_TOTP_KEY";
pub const JWT_GENERATED_ENV: &str = "OHIYO_JWT_SECRET_GENERATED";

pub fn base32_encode(_bytes: &[u8]) -> String {
    String::new()
}
pub fn base32_decode(_input: &str) -> Option<Vec<u8>> {
    None
}
pub fn generate_secret() -> Vec<u8> {
    vec![0u8; SECRET_BYTES]
}
pub fn hotp_raw(_secret: &[u8], _counter: u64) -> u32 {
    0
}
pub fn step_at(unix: i64) -> i64 {
    unix / STEP_SECS
}
pub fn code_for_step(_secret: &[u8], _step: i64) -> String {
    "000000".into()
}
pub fn totp_code(_secret: &[u8], _unix: i64) -> String {
    "000000".into()
}
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a == b
}
pub fn verify_code(_secret: &[u8], _typed: &str, _unix: i64, _last_step: i64) -> Option<i64> {
    None
}
pub fn otpauth_url(_secret: &[u8], _account: &str, _issuer: &str) -> String {
    String::new()
}
pub fn generate_recovery_codes() -> Vec<String> {
    Vec::new()
}
pub fn normalize_recovery_code(_typed: &str) -> Option<String> {
    None
}
pub fn hash_recovery_code(_user_id: &str, normalized: &str) -> String {
    normalized.to_owned()
}

#[derive(Clone)]
pub struct SecretBox;

impl std::fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stub")
    }
}

impl SecretBox {
    pub fn new(_master: &[u8]) -> Self {
        SecretBox
    }
    pub fn from_env() -> Option<Self> {
        None
    }
    pub fn from_values(
        _own_key: Option<&str>,
        _jwt: Option<&str>,
        _jwt_generated: bool,
    ) -> Option<Self> {
        None
    }
    pub fn seal(&self, _user_id: &str, plaintext: &[u8]) -> Vec<u8> {
        plaintext.to_vec()
    }
    pub fn open(&self, _user_id: &str, blob: &[u8]) -> Option<Vec<u8>> {
        Some(blob.to_vec())
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
