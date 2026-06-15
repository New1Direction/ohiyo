//! Signal Protocol (X3DH) prekey directory — multi-device. Each of a user's devices
//! publishes its own identity key, signed prekey, and one-time prekeys under
//! (user_id, device_id). A sender fetches every device's bundle (`/prekey-bundles`)
//! and fans out an encrypted copy to each. The server holds only PUBLIC keys — it can
//! never read message content. One-time prekeys are single-use (popped on fetch).

use axum::{
    extract::{Path, Query, State},
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
    /// This device's stable id (1..2^31). Distinguishes a user's devices.
    pub device_id: i64,
    pub identity_key: String,
    pub registration_id: i64,
    pub signed_prekey: SignedPreKeyIn,
    #[serde(default)]
    pub one_time_prekeys: Vec<OneTimePreKeyIn>,
}

/// POST /signal/keys — publish/refresh this device's identity + signed prekey and add
/// a batch of one-time prekeys (keyed by this user + device).
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

    // Pin the identity key per device. Once a device has published its identity key it
    // can't be changed (only its prekeys rotate; a reinstall gets a fresh device_id).
    // This stops a token-holder from silently replacing ANOTHER of the user's devices'
    // identity key to MITM messages fanned out to that device.
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT identity_key FROM signal_identity WHERE user_id = ? AND device_id = ?",
    )
    .bind(&auth.0)
    .bind(b.device_id)
    .fetch_optional(&state.db)
    .await
    .map_err(ise)?;
    if existing.is_some_and(|k| k != b.identity_key) {
        return Err((
            StatusCode::CONFLICT,
            "identity key is pinned for this device".into(),
        ));
    }

    let mut tx = state.db.begin().await.map_err(ise)?;
    sqlx::query(
        "INSERT INTO signal_identity
           (user_id, device_id, identity_key, registration_id, signed_prekey_id, signed_prekey, signed_prekey_sig, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           identity_key=excluded.identity_key, registration_id=excluded.registration_id,
           signed_prekey_id=excluded.signed_prekey_id, signed_prekey=excluded.signed_prekey,
           signed_prekey_sig=excluded.signed_prekey_sig, updated_at=excluded.updated_at",
    )
    .bind(&auth.0)
    .bind(b.device_id)
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
            "INSERT OR IGNORE INTO signal_one_time_prekeys (user_id, device_id, key_id, public_key) VALUES (?,?,?,?)",
        )
        .bind(&auth.0)
        .bind(b.device_id)
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
    pub device_id: i64,
    pub identity_key: String,
    pub registration_id: i64,
    pub signed_prekey: SignedPreKeyOut,
    /// None when this device has run out of one-time prekeys (X3DH still works, with
    /// slightly weaker first-message secrecy — the client should replenish).
    pub one_time_prekey: Option<OneTimePreKeyOut>,
}

/// GET /users/{user_id}/prekey-bundles — a bundle for EACH of the user's devices,
/// popping one one-time prekey per device (single-use). The sender encrypts a copy
/// for every returned device.
pub async fn get_bundles(
    _auth: AuthUser,
    Path(user_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<PreKeyBundleOut>>, (StatusCode, String)> {
    let devices: Vec<(i64, String, i64, i64, String, String)> = sqlx::query_as(
        "SELECT device_id, identity_key, registration_id, signed_prekey_id, signed_prekey, signed_prekey_sig
         FROM signal_identity WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_all(&state.db)
    .await
    .map_err(ise)?;

    let mut out = Vec::with_capacity(devices.len());
    for (device_id, identity_key, registration_id, spk_id, spk, spk_sig) in devices {
        // Pop one one-time prekey for this device under a transaction (single-use).
        let mut tx = state.db.begin().await.map_err(ise)?;
        let otk: Option<(i64, String)> = sqlx::query_as(
            "SELECT key_id, public_key FROM signal_one_time_prekeys
             WHERE user_id = ? AND device_id = ? LIMIT 1",
        )
        .bind(&user_id)
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ise)?;
        let one_time_prekey = if let Some((kid, pk)) = &otk {
            sqlx::query(
                "DELETE FROM signal_one_time_prekeys WHERE user_id = ? AND device_id = ? AND key_id = ?",
            )
            .bind(&user_id)
            .bind(device_id)
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

        out.push(PreKeyBundleOut {
            device_id,
            identity_key,
            registration_id,
            signed_prekey: SignedPreKeyOut {
                key_id: spk_id,
                public_key: spk,
                signature: spk_sig,
            },
            one_time_prekey,
        });
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CountQuery {
    pub device_id: i64,
}

/// GET /signal/keys/count?device_id=N — one-time prekeys left for this device, so the
/// client knows when to upload more.
pub async fn prekey_count(
    auth: AuthUser,
    Query(q): Query<CountQuery>,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM signal_one_time_prekeys WHERE user_id = ? AND device_id = ?",
    )
    .bind(&auth.0)
    .bind(q.device_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    Json(serde_json::json!({ "count": n }))
}

#[derive(Serialize)]
pub struct DeviceOut {
    pub device_id: i64,
    pub updated_at: i64,
}

/// GET /users/@me/devices — list this account's registered Signal devices. Read-only;
/// does NOT pop one-time prekeys (unlike get_bundles), so it's safe for display.
pub async fn list_devices(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<DeviceOut>>, (StatusCode, String)> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT device_id, updated_at FROM signal_identity WHERE user_id = ? ORDER BY device_id",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(ise)?;
    Ok(Json(
        rows.into_iter()
            .map(|(device_id, updated_at)| DeviceOut {
                device_id,
                updated_at,
            })
            .collect(),
    ))
}

/// DELETE /users/@me/devices/{device_id} — revoke a device from the directory: drop its
/// identity key + prekeys so no one can start new sessions with it. Used to deregister a
/// lost or stale device.
pub async fn remove_device(
    auth: AuthUser,
    Path(device_id): Path<i64>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM signal_one_time_prekeys WHERE user_id = ? AND device_id = ?")
        .bind(&auth.0)
        .bind(device_id)
        .execute(&state.db)
        .await
        .map_err(ise)?;
    sqlx::query("DELETE FROM signal_identity WHERE user_id = ? AND device_id = ?")
        .bind(&auth.0)
        .bind(device_id)
        .execute(&state.db)
        .await
        .map_err(ise)?;
    Ok(StatusCode::NO_CONTENT)
}
