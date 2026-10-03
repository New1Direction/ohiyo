use anyhow::Result;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::{
    extract::{FromRef, FromRequestParts},
    http::request::Parts,
};
use axum_extra::{
    headers::{authorization::Bearer, Authorization},
    TypedHeader,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};

use crate::types::Claims;
use crate::AppState;

pub const JWT_EXPIRY_SECS: usize = 60 * 60 * 24 * 30; // 30 days

/// The JWT signing secret. `main()` guarantees `JWT_SECRET` is present (it
/// generates an ephemeral one if the operator didn't provide it), so this does
/// not panic in a normally-started server. There is deliberately NO hardcoded
/// fallback — that was a token-forgery risk in production.
pub fn jwt_secret() -> String {
    std::env::var("JWT_SECRET")
        .expect("JWT_SECRET must be set — start the server via main(), which guarantees it")
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    // Argon2id (hybrid) per OWASP / RFC 9106 — Argon2::default() is Argon2i, which is
    // weaker against time-space tradeoff attacks. Params: 19 MiB memory, t=2, p=1. Verify
    // stays on Argon2::default() since the algorithm/params are read from the stored PHC
    // string, so existing Argon2i hashes keep verifying.
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(|e| anyhow::anyhow!("argon2 params: {e}"))?,
    );
    let hash = argon
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash error: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn create_token(user_id: &str, token_version: i64, secret: &str) -> Result<String> {
    let exp = (chrono::Utc::now().timestamp() as usize) + JWT_EXPIRY_SECS;
    let claims = Claims {
        sub: user_id.to_owned(),
        exp,
        token_version,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(data.claims)
}

// ── Extractor: pulls user_id from Bearer token ────────────────────────────────

#[derive(Debug, Clone)]
pub struct AuthUser(pub String);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = (axum::http::StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let secret = jwt_secret();

        let TypedHeader(Authorization(bearer)) =
            TypedHeader::<Authorization<Bearer>>::from_request_parts(parts, state)
                .await
                .map_err(|_| (axum::http::StatusCode::UNAUTHORIZED, "missing token"))?;

        let claims = verify_token(bearer.token(), &secret)
            .map_err(|_| (axum::http::StatusCode::UNAUTHORIZED, "invalid token"))?;

        // Instant revocation: the token carries the user's `token_version` (stamped at
        // mint time; see `create_token`). "Log out everywhere" and password changes bump
        // `users.token_version`, which immediately invalidates every previously minted
        // token. We verify it here on every authenticated request — one indexed SELECT
        // against in-process SQLite, cheap enough for this server's scale. A missing row
        // (deleted user) or a token minted before the current version is rejected.
        let app = AppState::from_ref(state);
        let current: Option<i64> =
            sqlx::query_scalar("SELECT token_version FROM users WHERE id = ?")
                .bind(&claims.sub)
                .fetch_optional(&app.db)
                .await
                .map_err(|_| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "auth check failed",
                    )
                })?;

        match current {
            Some(v) if claims.token_version >= v => Ok(AuthUser(claims.sub)),
            Some(_) => Err((axum::http::StatusCode::UNAUTHORIZED, "token revoked")),
            None => Err((axum::http::StatusCode::UNAUTHORIZED, "invalid token")),
        }
    }
}

// ── Operators: instance-wide staff, named by environment ──────────────────────

/// Comma-separated user ids allowed to perform operator-only actions (for example
/// changing a hosted instance's tier). Unset or empty means nobody.
const OPERATOR_USER_IDS_ENV: &str = "OHIYO_OPERATOR_USER_IDS";

/// True if `user_id` is listed in `OHIYO_OPERATOR_USER_IDS`. Read on every call, so
/// there is no cached copy to drift from the environment.
pub fn is_operator(user_id: &str) -> bool {
    operator_listed(
        std::env::var(OPERATOR_USER_IDS_ENV).ok().as_deref(),
        user_id,
    )
}

/// Whether `user_id` appears in a raw comma-separated operator list. Entries are
/// trimmed and blank entries ignored, so a stray comma can never match an empty id.
fn operator_listed(raw: Option<&str>, user_id: &str) -> bool {
    raw.is_some_and(|raw| {
        raw.split(',')
            .map(str::trim)
            .any(|id| !id.is_empty() && id == user_id)
    })
}

#[cfg(test)]
mod operator_tests {
    use super::*;

    #[test]
    fn unset_means_nobody() {
        assert!(!operator_listed(None, "u1"));
    }

    #[test]
    fn empty_means_nobody() {
        assert!(!operator_listed(Some(""), "u1"));
        assert!(!operator_listed(Some(" , ,"), "u1"));
        assert!(
            !operator_listed(Some(" , ,"), ""),
            "a blank id never matches"
        );
    }

    #[test]
    fn single_id_matches_only_itself() {
        assert!(operator_listed(Some("u1"), "u1"));
        assert!(!operator_listed(Some("u1"), "u2"));
        assert!(!operator_listed(Some("u1"), "u"), "no prefix matches");
    }

    #[test]
    fn multiple_ids_each_match() {
        let raw = Some("u1,u2,u3");
        assert!(operator_listed(raw, "u1"));
        assert!(operator_listed(raw, "u2"));
        assert!(operator_listed(raw, "u3"));
        assert!(!operator_listed(raw, "u4"));
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        let raw = Some("  u1 ,\tu2\n, ");
        assert!(operator_listed(raw, "u1"));
        assert!(operator_listed(raw, "u2"));
        assert!(!operator_listed(raw, ""));
    }
}

/// Session tokens must look and validate the same across `jsonwebtoken` upgrades: a
/// token minted before an upgrade has to keep working after it, and nothing the old
/// validation refused may start passing. Every token here was minted by jsonwebtoken
/// 9.3.1 (or, for `alg: none`, built by hand) with the secret below.
#[cfg(test)]
mod token_pin_tests {
    use super::*;

    const SECRET: &str = "pinned-test-secret-0123456789abcdef";
    /// `{"sub":"user-1","exp":4102444800,"token_version":3}`, HS256.
    const VALID: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjQxMDI0NDQ4MDAsInRva2VuX3ZlcnNpb24iOjN9.eeepY_eaEdRNeA4mr96xVozcRss2oebBgQDnqkOy7kE";
    /// The same claims under HS384.
    const HS384: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzM4NCJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjQxMDI0NDQ4MDAsInRva2VuX3ZlcnNpb24iOjN9.FHFVMVUR63XvUjR7XQ1ynpyNGyYMt-B3_QTOWCOl4poesXcMkWIIdAnSVtMmKfC2";
    /// HS256 with no `exp` claim.
    const NO_EXP: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0b2tlbl92ZXJzaW9uIjozfQ.tiN--s2e83ONgERBjFwtvHHXEf-nIZVcLce9vDqMcvA";
    /// HS256, `exp` in 2001.
    const EXPIRED: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjEwMDAwMDAwMDAsInRva2VuX3ZlcnNpb24iOjN9.AcFN_oNp7V-X8JIQmhAphpDSjtu1eLfJAtduzV49J10";
    /// The valid claims signed with a different secret.
    const OTHER_KEY: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjQxMDI0NDQ4MDAsInRva2VuX3ZlcnNpb24iOjN9.ZC3xJSg7FZdzM-GayuKk8aSulV8UaIHkIZ8jQh8PAFE";
    /// The valid claims, unsigned, `{"alg":"none","typ":"JWT"}`.
    const ALG_NONE: &str = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjQxMDI0NDQ4MDAsInRva2VuX3ZlcnNpb24iOjN9.";

    #[test]
    fn a_pinned_token_still_validates_with_its_claims() {
        let claims = verify_token(VALID, SECRET).expect("pinned token validates");
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.exp, 4_102_444_800);
        assert_eq!(claims.token_version, 3);
    }

    #[test]
    fn new_tokens_keep_the_pinned_header() {
        let token = create_token("user-1", 3, SECRET).unwrap();
        let header = token.split('.').next().unwrap();
        assert_eq!(header, VALID.split('.').next().unwrap(), "HS256, typ JWT");
        assert_eq!(verify_token(&token, SECRET).unwrap().token_version, 3);
    }

    #[test]
    fn only_hs256_tokens_with_a_valid_signature_and_a_future_exp_pass() {
        for (name, token) in [
            ("HS384", HS384),
            ("no exp", NO_EXP),
            ("expired", EXPIRED),
            ("other key", OTHER_KEY),
            ("alg none", ALG_NONE),
        ] {
            assert!(
                verify_token(token, SECRET).is_err(),
                "{name} must be refused"
            );
        }
    }
}
