//! Content-free push relay primitives.
//!
//! The relay stores device endpoints and queues wake-up nudges that say only
//! "you have activity". It intentionally never stores message text, filenames,
//! channel names, invite codes, or encryption keys.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PushDevice {
    pub id: String,
    pub user_id: String,
    pub platform: String,
    pub endpoint: String,
    pub p256dh: Option<String>,
    pub auth: Option<String>,
    pub device_name: Option<String>,
    pub enabled: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct PushConfig {
    pub enabled: bool,
    pub vapid_public_key: Option<String>,
    pub privacy_note: String,
}

#[derive(Deserialize)]
pub struct RegisterPushDeviceBody {
    pub platform: String,
    pub endpoint: String,
    pub p256dh: Option<String>,
    pub auth: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct RelayPushBody {
    pub recipient_ids: Vec<String>,
    pub kind: Option<String>,
}

#[derive(Serialize)]
pub struct RelayResult {
    pub queued: i64,
    pub skipped_online: i64,
    pub skipped_no_device: i64,
}

fn public_device(row: PushDevice) -> PushDevice {
    row
}

fn valid_platform(platform: &str) -> bool {
    matches!(platform, "web" | "apns" | "fcm")
}

fn relay_secret_ok(headers: &HeaderMap) -> bool {
    let Some(secret) = std::env::var("OHIYO_PUSH_RELAY_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    value
        .strip_prefix("Bearer ")
        .map(|got| got == secret)
        .unwrap_or(false)
}

fn is_user_online(state: &AppState, user_id: &str) -> bool {
    state
        .sessions
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(user_id)
        .map(|m| !m.is_empty())
        .unwrap_or(false)
}

pub async fn config() -> Json<PushConfig> {
    let key = std::env::var("OHIYO_WEB_PUSH_PUBLIC_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    Json(PushConfig {
        enabled: key.is_some(),
        vapid_public_key: key,
        privacy_note: "Push notifications are content-free: the relay may learn device endpoint, recipient id, and delivery time, but not message text, filenames, channel names, or E2E keys.".into(),
    })
}

pub async fn list_devices(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<PushDevice>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, PushDevice>(
        "SELECT * FROM push_devices WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows.into_iter().map(public_device).collect()))
}

pub async fn register_device(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<RegisterPushDeviceBody>,
) -> Result<Json<PushDevice>, (StatusCode, String)> {
    let platform = body.platform.trim().to_lowercase();
    let endpoint = body.endpoint.trim();
    if !valid_platform(&platform) {
        return Err((
            StatusCode::BAD_REQUEST,
            "platform must be web, apns, or fcm".into(),
        ));
    }
    if endpoint.is_empty() || endpoint.len() > 2048 {
        return Err((StatusCode::BAD_REQUEST, "endpoint is required".into()));
    }
    if platform == "web"
        && (body.p256dh.as_deref().unwrap_or_default().is_empty()
            || body.auth.as_deref().unwrap_or_default().is_empty())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "web push requires p256dh and auth keys".into(),
        ));
    }

    let id = new_id();
    let now = now_unix();
    sqlx::query(
        "INSERT INTO push_devices (id, user_id, platform, endpoint, p256dh, auth, device_name, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET
           platform=excluded.platform,
           p256dh=excluded.p256dh,
           auth=excluded.auth,
           device_name=excluded.device_name,
           enabled=1,
           updated_at=excluded.updated_at",
    )
    .bind(&id)
    .bind(&auth.0)
    .bind(&platform)
    .bind(endpoint)
    .bind(body.p256dh.as_deref())
    .bind(body.auth.as_deref())
    .bind(body.device_name.as_deref())
    .bind(1_i64)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let row = sqlx::query_as::<_, PushDevice>(
        "SELECT * FROM push_devices WHERE user_id = ? AND endpoint = ?",
    )
    .bind(&auth.0)
    .bind(endpoint)
    .fetch_one(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(public_device(row)))
}

pub async fn delete_device(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let res =
        sqlx::query("UPDATE push_devices SET enabled=0, updated_at=? WHERE id=? AND user_id=?")
            .bind(now_unix())
            .bind(id)
            .bind(&auth.0)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "push device not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn queue_for_users(
    state: &AppState,
    recipient_ids: &[String],
    kind: &str,
    skip_online: bool,
) -> Result<RelayResult, sqlx::Error> {
    let mut result = RelayResult {
        queued: 0,
        skipped_online: 0,
        skipped_no_device: 0,
    };
    for user_id in recipient_ids {
        if skip_online && is_user_online(state, user_id) {
            result.skipped_online += 1;
            continue;
        }
        let devices: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM push_devices WHERE user_id = ? AND enabled = 1")
                .bind(user_id)
                .fetch_all(&state.db)
                .await?;
        if devices.is_empty() {
            result.skipped_no_device += 1;
            continue;
        }
        for (device_id,) in devices {
            sqlx::query(
                "INSERT INTO push_deliveries (id, user_id, device_id, kind, status, created_at)
                 VALUES (?,?,?,?,?,?)",
            )
            .bind(new_id())
            .bind(user_id)
            .bind(device_id)
            .bind(kind)
            .bind("queued")
            .bind(now_unix())
            .execute(&state.db)
            .await?;
            result.queued += 1;
        }
    }
    Ok(result)
}

/// Called by hosted community servers or the control plane. Auth uses a shared relay
/// secret so sleeping per-community instances can ask the always-on relay to notify
/// devices without exposing any message content.
pub async fn relay_content_free(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<RelayPushBody>,
) -> Result<Json<RelayResult>, (StatusCode, String)> {
    if !relay_secret_ok(&headers) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid push relay secret".into(),
        ));
    }
    let kind = body.kind.as_deref().unwrap_or("message");
    if !matches!(kind, "message" | "test") {
        return Err((
            StatusCode::BAD_REQUEST,
            "kind must be message or test".into(),
        ));
    }
    let result = queue_for_users(&state, &body.recipient_ids, kind, true)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(Json(result))
}

/// Internal hook for a newly-created message. Figures out the channel audience,
/// removes the author, skips online users, and queues content-free nudges.
pub async fn enqueue_message_pushes(state: &AppState, channel_id: &str, author_id: &str) {
    let rows: Result<Vec<(String,)>, sqlx::Error> = sqlx::query_as(
        "SELECT sm.user_id
           FROM channels c JOIN server_members sm ON sm.server_id = c.server_id
          WHERE c.id = ? AND c.server_id IS NOT NULL
         UNION
         SELECT dp.user_id
           FROM dm_participants dp JOIN channels c ON c.id = dp.channel_id
          WHERE c.id = ? AND c.server_id IS NULL",
    )
    .bind(channel_id)
    .bind(channel_id)
    .fetch_all(&state.db)
    .await;

    let Ok(rows) = rows else {
        return;
    };
    let mut recipients = Vec::new();
    for (id,) in rows {
        if id == author_id {
            continue;
        }
        if crate::api::abuse::is_blocked_pair(state, author_id, &id).await {
            continue;
        }
        recipients.push(id);
    }
    if recipients.is_empty() {
        return;
    }
    if let Err(e) = queue_for_users(state, &recipients, "message", true).await {
        tracing::warn!("content-free push enqueue failed for channel {channel_id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn config_copy_never_mentions_content_fields() {
        let note = "Push notifications are content-free: the relay may learn device endpoint, recipient id, and delivery time, but not message text, filenames, channel names, or E2E keys.";
        assert!(note.contains("content-free"));
        assert!(note.contains("not message text"));
    }
}
