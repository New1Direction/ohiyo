//! LiveKit access-token minting — the server half of the optional SFU voice path.
//!
//! We self-sign the join JWT with `jsonwebtoken` (HS256 over the API secret, with
//! `iss` = API key), which is LiveKit's documented token format — no extra SDK.
//! Feature-flagged via LIVEKIT_ENABLED (+ URL/KEY/SECRET). When off, /livekit/config
//! reports disabled and the client keeps using the built-in peer-to-peer mesh.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;

use crate::{api::messages::user_can_access, auth::AuthUser, AppState};

/// 10 min — limits the post-kick window (LiveKit has no revocation callback in a
/// standard deploy); the client re-mints on reconnect, so a short TTL costs nothing.
const TOKEN_TTL_SECS: i64 = 10 * 60;

#[derive(Serialize)]
pub struct LiveKitConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct LiveKitToken {
    pub token: String,
    pub url: String,
    pub room: String,
}

#[derive(Serialize)]
struct VideoGrant {
    room: String,
    #[serde(rename = "roomJoin")]
    room_join: bool,
    #[serde(rename = "canPublish")]
    can_publish: bool,
    #[serde(rename = "canSubscribe")]
    can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    can_publish_data: bool,
}

#[derive(Serialize)]
struct LiveKitClaims {
    iss: String, // API key
    sub: String, // participant identity (= user_id, so the client can map back)
    jti: String, // unique token id — LiveKit uses it for dedup / one-use semantics
    exp: i64,
    nbf: i64,
    name: String, // display name shown to other participants
    video: VideoGrant,
}

/// `(url, api_key, api_secret)` when LiveKit is fully configured.
fn config() -> Option<(String, String, String)> {
    let url = std::env::var("LIVEKIT_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let key = std::env::var("LIVEKIT_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let secret = std::env::var("LIVEKIT_API_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    Some((url, key, secret))
}

pub fn livekit_enabled() -> bool {
    std::env::var("LIVEKIT_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
        && config().is_some()
}

/// GET /livekit/config — lets the client decide between SFU and P2P at runtime.
pub async fn livekit_config(_auth: AuthUser) -> Json<LiveKitConfig> {
    if livekit_enabled() {
        Json(LiveKitConfig {
            enabled: true,
            url: config().map(|(u, _, _)| u),
        })
    } else {
        Json(LiveKitConfig {
            enabled: false,
            url: None,
        })
    }
}

/// POST /channels/{channel_id}/livekit-token — mint a room-scoped join token for a
/// channel the caller can access (room name = channel_id, identity = user_id).
pub async fn create_livekit_token(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<LiveKitToken>, (StatusCode, String)> {
    let Some((url, api_key, api_secret)) = config() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "livekit not configured".into(),
        ));
    };
    if !livekit_enabled() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "livekit disabled".into()));
    }
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }

    let name: String =
        sqlx::query_scalar::<_, String>("SELECT display_name FROM users WHERE id = ?")
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| auth.0.clone());

    let now = chrono::Utc::now().timestamp();
    let claims = LiveKitClaims {
        iss: api_key,
        sub: auth.0.clone(),
        jti: crate::types::new_id(),
        exp: now + TOKEN_TTL_SECS,
        nbf: now - 10,
        name,
        video: VideoGrant {
            room: channel_id.clone(),
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map_err(|e| {
        // Don't leak JWT/crypto internals to the client; log server-side, return generic.
        tracing::error!("livekit token mint failed for {}: {e}", auth.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not create voice token".to_owned(),
        )
    })?;

    Ok(Json(LiveKitToken {
        token,
        url,
        room: channel_id,
    }))
}
