//! Catching up, like Discord: "Mark as read" on a channel or DM, "Mark space as read" and
//! Shift+Esc mark many chats read in one request, each up to its newest message. Only chats
//! you can read are marked; the rest are skipped without saying which exist. Your other open
//! devices hear about it (`ReadStateUpdate`), so their unread numbers clear too.

use std::{collections::HashSet, time::Duration};

use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    gateway::{broadcast_to_user, record_read},
    types::{now_unix, GatewayEvent, ReadMark},
    AppState,
};

/// The most chats one request may mark (the app sends more in batches).
pub const MAX_CHATS: usize = 200;
/// Requests per account per minute: plenty for a person, little for a script.
const REQUESTS_PER_MINUTE: usize = 30;

#[derive(Deserialize)]
pub struct MarkReadBody {
    pub channel_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct MarkReadResponse {
    /// The chats now read, each up to its newest message (empty chats have nothing to mark).
    pub reads: Vec<ReadMark>,
}

/// POST /users/@me/read — mark these chats read up to their newest message.
pub async fn mark_read(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<MarkReadBody>,
) -> Result<Json<MarkReadResponse>, (StatusCode, String)> {
    if body.channel_ids.len() > MAX_CHATS {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("mark at most {MAX_CHATS} chats at a time"),
        ));
    }
    if !state.rate.check(
        &format!("mark-read:{}", auth.0),
        REQUESTS_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "slow down — try again in a minute".into(),
        ));
    }

    let now = now_unix();
    let mut seen = HashSet::new();
    let mut reads = Vec::new();
    for channel_id in body
        .channel_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
    {
        if !crate::api::messages::user_can_access(&state, channel_id, &auth.0).await {
            continue;
        }
        // The newest message still there (a disappearing one that has expired doesn't count).
        let newest: Option<(String, i64)> = sqlx::query_as(
            "SELECT id, created_at FROM messages
             WHERE channel_id = ? AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(channel_id)
        .bind(now)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
        let Some((message_id, watermark)) = newest else {
            continue;
        };
        record_read(&state, &auth.0, channel_id, &message_id, watermark).await;
        reads.push(ReadMark {
            channel_id: channel_id.clone(),
            last_read_message_id: message_id,
            last_read_at: watermark,
        });
    }

    if !reads.is_empty() {
        broadcast_to_user(
            &state.sessions,
            &auth.0,
            &GatewayEvent::ReadStateUpdate {
                reads: reads.clone(),
            },
        );
    }
    Ok(Json(MarkReadResponse { reads }))
}
