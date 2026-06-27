use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix, Channel, PublicUser, User},
    AppState,
};

/// DM links are bearer capabilities. Keep creation low enough to discourage link
/// spraying, but high enough that regenerating after a copy mistake is painless.
const CREATE_RATE_MAX: usize = 10;
const REDEEM_RATE_MAX: usize = 30;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const TOKEN_BYTES: usize = 32;
const DEFAULT_TTL_SECS: i64 = 60 * 60 * 24; // 24h
const MAX_TTL_SECS: i64 = 60 * 60 * 24 * 7; // 7d

#[derive(Debug, sqlx::FromRow)]
struct PrivateDmLink {
    created_by: String,
    created_at: i64,
    expires_at: i64,
    used_at: Option<i64>,
    revoked_at: Option<i64>,
}

#[derive(Deserialize, Default)]
pub struct CreatePrivateDmLinkBody {
    pub expires_in_secs: Option<i64>,
}

#[derive(Serialize)]
pub struct PrivateDmLinkCreated {
    /// Secret bearer token. Returned exactly once; only a digest is stored server-side.
    pub token: String,
    pub expires_at: i64,
}

#[derive(Serialize)]
pub struct PrivateDmLinkPreview {
    pub creator: PublicUser,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Serialize)]
pub struct PrivateDmLinkRedeemed {
    pub channel: Channel,
    pub creator: PublicUser,
}

fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Scope the hash so the digest cannot be confused with other future bearer tokens.
fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"ohiyo-private-dm-link-v1:\0");
    h.update(token.as_bytes());
    format!("{:x}", h.finalize())
}

fn plausible_token(token: &str) -> bool {
    (32..=96).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn gone() -> (StatusCode, String) {
    (
        StatusCode::GONE,
        "this private DM link is invalid, expired, or already used".into(),
    )
}

fn not_found() -> (StatusCode, String) {
    (
        StatusCode::NOT_FOUND,
        "this private DM link is invalid, expired, or already used".into(),
    )
}

async fn load_live_link(
    state: &AppState,
    token: &str,
) -> Result<PrivateDmLink, (StatusCode, String)> {
    if !plausible_token(token) {
        return Err(not_found());
    }
    let hash = token_hash(token);
    let link: Option<PrivateDmLink> = sqlx::query_as(
        "SELECT created_by, created_at, expires_at, used_at, revoked_at
         FROM private_dm_links
         WHERE token_hash = ?",
    )
    .bind(hash)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let link = link.ok_or_else(not_found)?;
    if link.revoked_at.is_some() || link.used_at.is_some() || link.expires_at <= now_unix() {
        return Err(gone());
    }
    Ok(link)
}

async fn fetch_public_user(
    state: &AppState,
    user_id: &str,
) -> Result<PublicUser, (StatusCode, String)> {
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(user.into())
}

/// POST /users/@me/dm-links — create a one-time private DM link.
pub async fn create_private_dm_link(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreatePrivateDmLinkBody>,
) -> Result<Json<PrivateDmLinkCreated>, (StatusCode, String)> {
    if !state.rate.check(
        &format!("dm-link-create:{}", auth.0),
        CREATE_RATE_MAX,
        RATE_WINDOW,
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }

    let now = now_unix();
    let ttl = body
        .expires_in_secs
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_TTL_SECS)
        .min(MAX_TTL_SECS);
    let expires_at = now + ttl;

    // Retry on astronomically unlikely digest collision.
    for _ in 0..4 {
        let token = generate_token();
        let hash = token_hash(&token);
        let res = sqlx::query(
            "INSERT INTO private_dm_links (token_hash, created_by, created_at, expires_at)
             VALUES (?,?,?,?)",
        )
        .bind(hash)
        .bind(&auth.0)
        .bind(now)
        .bind(expires_at)
        .execute(&state.db)
        .await;

        match res {
            Ok(_) => return Ok(Json(PrivateDmLinkCreated { token, expires_at })),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(crate::api::error::internal(e)),
        }
    }

    Err((
        StatusCode::INTERNAL_SERVER_ERROR,
        "couldn't allocate a private DM link".into(),
    ))
}

/// GET /dm-links/{token} — authenticated, token-gated preview before redeeming.
pub async fn preview_private_dm_link(
    _auth: AuthUser,
    Path(token): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<PrivateDmLinkPreview>, (StatusCode, String)> {
    let link = load_live_link(&state, &token).await?;
    let creator = fetch_public_user(&state, &link.created_by).await?;
    Ok(Json(PrivateDmLinkPreview {
        creator,
        created_at: link.created_at,
        expires_at: link.expires_at,
    }))
}

/// POST /dm-links/{token} — atomically consume a link and open/create the 1:1 DM.
pub async fn redeem_private_dm_link(
    auth: AuthUser,
    Path(token): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<PrivateDmLinkRedeemed>, (StatusCode, String)> {
    if !plausible_token(&token) {
        return Err(not_found());
    }
    if !state.rate.check(
        &format!("dm-link-redeem:{}", auth.0),
        REDEEM_RATE_MAX,
        RATE_WINDOW,
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }

    let hash = token_hash(&token);
    let now = now_unix();
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;

    let link: Option<PrivateDmLink> = sqlx::query_as(
        "SELECT created_by, created_at, expires_at, used_at, revoked_at
         FROM private_dm_links
         WHERE token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;

    let link = link.ok_or_else(not_found)?;
    if link.revoked_at.is_some() || link.used_at.is_some() || link.expires_at <= now {
        return Err(gone());
    }
    if link.created_by == auth.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "you can't use your own private DM link".into(),
        ));
    }

    let touched = sqlx::query(
        "UPDATE private_dm_links
         SET used_at = ?, used_by = ?
         WHERE token_hash = ?
           AND used_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > ?
           AND created_by != ?",
    )
    .bind(now)
    .bind(&auth.0)
    .bind(&hash)
    .bind(now)
    .bind(&auth.0)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    if touched.rows_affected() != 1 {
        return Err(gone());
    }

    let creator: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&link.created_by)
        .fetch_one(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    let channel = open_or_create_dm_in_tx(&mut tx, &auth.0, &link.created_by).await?;

    tx.commit().await.map_err(crate::api::error::internal)?;
    Ok(Json(PrivateDmLinkRedeemed {
        channel,
        creator: creator.into(),
    }))
}

/// DELETE /dm-links/{token} — creator can revoke the still-live link they just made.
pub async fn revoke_private_dm_link(
    auth: AuthUser,
    Path(token): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !plausible_token(&token) {
        return Err(not_found());
    }
    let now = now_unix();
    let touched = sqlx::query(
        "UPDATE private_dm_links
         SET revoked_at = ?
         WHERE token_hash = ?
           AND created_by = ?
           AND used_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > ?",
    )
    .bind(now)
    .bind(token_hash(&token))
    .bind(&auth.0)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    if touched.rows_affected() == 0 {
        return Err(gone());
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn open_or_create_dm_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_a: &str,
    user_b: &str,
) -> Result<Channel, (StatusCode, String)> {
    let existing: Option<Channel> = sqlx::query_as(
        "SELECT c.* FROM channels c
         JOIN dm_participants dp1 ON dp1.channel_id = c.id AND dp1.user_id = ?
         JOIN dm_participants dp2 ON dp2.channel_id = c.id AND dp2.user_id = ?
         WHERE c.channel_type = 'dm'
         LIMIT 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(&mut **tx)
    .await
    .map_err(crate::api::error::internal)?;

    if let Some(ch) = existing {
        return Ok(ch);
    }

    let id = new_id();
    let now = now_unix();
    sqlx::query(
        "INSERT INTO channels (id, name, channel_type, position, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind("dm")
    .bind("dm")
    .bind(0i64)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(crate::api::error::internal)?;

    for uid in [user_a, user_b] {
        sqlx::query("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)")
            .bind(&id)
            .bind(uid)
            .execute(&mut **tx)
            .await
            .map_err(crate::api::error::internal)?;
    }

    Ok(Channel {
        id,
        server_id: None,
        name: "dm".to_owned(),
        channel_type: "dm".to_owned(),
        position: 0,
        topic: None,
        created_at: now,
        category_id: None,
        imported: false,
        disappearing_seconds: None,
        epoch: 0,
        owner_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_url_safe_and_high_entropy_length() {
        let token = generate_token();
        assert_eq!(token.len(), 43);
        assert!(plausible_token(&token));
        assert!(token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn token_hash_is_scoped_and_deterministic() {
        let token = "abcDEF_123-456";
        assert_eq!(token_hash(token), token_hash(token));
        assert_ne!(token_hash(token), token_hash("abcDEF_123-457"));
        assert_eq!(token_hash(token).len(), 64);
    }

    #[test]
    fn plausible_token_rejects_tiny_or_query_injection_values() {
        assert!(!plausible_token("short"));
        assert!(!plausible_token("abcdefghijklmnopqrstuvwxyz123456?x=1"));
        assert!(plausible_token("abcdefghijklmnopqrstuvwxyz123456ABCDEFGH"));
    }
}
