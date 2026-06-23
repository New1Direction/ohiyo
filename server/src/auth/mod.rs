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
