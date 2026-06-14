use anyhow::Result;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::{TypedHeader, headers::{Authorization, authorization::Bearer}};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};

use crate::types::Claims;

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
    let hash = Argon2::default()
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

pub fn create_token(user_id: &str, secret: &str) -> Result<String> {
    let exp = (chrono::Utc::now().timestamp() as usize) + JWT_EXPIRY_SECS;
    let claims = Claims { sub: user_id.to_owned(), exp };
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
{
    type Rejection = (axum::http::StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let secret = jwt_secret();

        let TypedHeader(Authorization(bearer)) =
            TypedHeader::<Authorization<Bearer>>::from_request_parts(parts, _state)
                .await
                .map_err(|_| (axum::http::StatusCode::UNAUTHORIZED, "missing token"))?;

        let claims = verify_token(bearer.token(), &secret)
            .map_err(|_| (axum::http::StatusCode::UNAUTHORIZED, "invalid token"))?;

        Ok(AuthUser(claims.sub))
    }
}
