//! Signal Protocol (X3DH) prekey directory. Users publish an identity key, a signed
//! prekey, and a batch of one-time prekeys; peers fetch a bundle to bootstrap a
//! forward-secret session. The server holds only PUBLIC keys — it can never read
//! message content or derive a session. One-time prekeys are single-use (popped on
//! fetch); clients replenish when the count runs low.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{auth::AuthUser, types::now_unix, AppState};

fn ise<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[derive(Deserialize)]
pub struct SignedPreKeyIn {
    pub key_id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct OneTimePreKeyIn {
    pub key_id: i64,
    pub public_key: String,
}

#[derive(Deserialize)]
pub struct PublishKeysBody {
    pub identity_key: String,
    pub registration_id: i64,
    pub signed_prekey: SignedPreKeyIn,
    #[serde(default)]
    pub one_time_prekeys: Vec<OneTimePreKeyIn>,
}

/// POST /signal/keys — publish/refresh this device's identity + signed prekey and
/// add a batch of one-time prekeys.
pub async fn publish_keys(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<PublishKeysBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if b.identity_key.len() > 1000
        || b.signed_prekey.public_key.len() > 1000
        || b.signed_prekey.signature.len() > 1000
    {
        return Err((StatusCode::BAD_REQUEST, "key too large".into()));
    }
    if b.one_time_prekeys.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "too many one-time prekeys".into()));
    }

    let mut tx = state.db.begin().await.map_err(ise)?;
    sqlx::query(
        "INSERT INTO signal_identity
           (user_id, identity_key, registration_id, signed_prekey_id, signed_prekey, signed_prekey_sig, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           identity_key=excluded.identity_key, registration_id=excluded.registration_id,
           signed_prekey_id=excluded.signed_prekey_id, signed_prekey=excluded.signed_prekey,
           signed_prekey_sig=excluded.signed_prekey_sig, updated_at=excluded.updated_at",
    )
    .bind(&auth.0)
    .bind(&b.identity_key)
    .bind(b.registration_id)
    .bind(b.signed_prekey.key_id)
    .bind(&b.signed_prekey.public_key)
    .bind(&b.signed_prekey.signature)
    .bind(now_unix())
    .execute(&mut *tx)
    .await
    .map_err(ise)?;

    for otk in &b.one_time_prekeys {
        if otk.public_key.len() > 1000 {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO signal_one_time_prekeys (user_id, key_id, public_key) VALUES (?,?,?)",
        )
        .bind(&auth.0)
        .bind(otk.key_id)
        .bind(&otk.public_key)
        .execute(&mut *tx)
        .await
        .map_err(ise)?;
    }
    tx.commit().await.map_err(ise)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct SignedPreKeyOut {
    pub key_id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Serialize)]
pub struct OneTimePreKeyOut {
    pub key_id: i64,
    pub public_key: String,
}

#[derive(Serialize)]
pub struct PreKeyBundleOut {
    pub identity_key: String,
    pub registration_id: i64,
    pub signed_prekey: SignedPreKeyOut,
    /// None when the user has run out of one-time prekeys (X3DH still works, with
    /// slightly weaker first-message secrecy — the client should replenish).
    pub one_time_prekey: Option<OneTimePreKeyOut>,
}

/// GET /users/{user_id}/prekey-bundle — fetch a bundle to start a session, popping
/// one one-time prekey (single-use).
pub async fn get_bundle(
    _auth: AuthUser,
    Path(user_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<PreKeyBundleOut>, (StatusCode, String)> {
    let row: Option<(String, i64, i64, String, String)> = sqlx::query_as(
        "SELECT identity_key, registration_id, signed_prekey_id, signed_prekey, signed_prekey_sig
         FROM signal_identity WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(ise)?;
    let (identity_key, registration_id, spk_id, spk, spk_sig) =
        row.ok_or((StatusCode::NOT_FOUND, "user has no Signal keys".into()))?;

    // Pop one one-time prekey under a transaction (single-use, race-safe).
    let mut tx = state.db.begin().await.map_err(ise)?;
    let otk: Option<(i64, String)> = sqlx::query_as(
        "SELECT key_id, public_key FROM signal_one_time_prekeys WHERE user_id = ? LIMIT 1",
    )
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ise)?;
    let one_time_prekey = if let Some((kid, pk)) = &otk {
        sqlx::query("DELETE FROM signal_one_time_prekeys WHERE user_id = ? AND key_id = ?")
            .bind(&user_id)
            .bind(kid)
            .execute(&mut *tx)
            .await
            .map_err(ise)?;
        Some(OneTimePreKeyOut {
            key_id: *kid,
            public_key: pk.clone(),
        })
    } else {
        None
    };
    tx.commit().await.map_err(ise)?;

    Ok(Json(PreKeyBundleOut {
        identity_key,
        registration_id,
        signed_prekey: SignedPreKeyOut {
            key_id: spk_id,
            public_key: spk,
            signature: spk_sig,
        },
        one_time_prekey,
    }))
}

/// GET /signal/keys/count — how many one-time prekeys this user has left (so the
/// client knows when to upload more).
pub async fn prekey_count(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM signal_one_time_prekeys WHERE user_id = ?")
            .bind(&auth.0)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
    Json(serde_json::json!({ "count": n }))
}
