use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::messages::{build_full, user_can_access},
    auth::AuthUser,
    types::{now_unix, Message, MessageWithAuthor},
    AppState,
};

/// POST /channels/{channel_id}/messages/{message_id}/save — bookmark a message.
pub async fn save_message(
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&message_id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    if exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "message not found".into()));
    }
    sqlx::query(
        "INSERT OR IGNORE INTO saved_messages (user_id, message_id, saved_at) VALUES (?,?,?)",
    )
    .bind(&auth.0)
    .bind(&message_id)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /channels/{channel_id}/messages/{message_id}/save — remove a bookmark.
pub async fn unsave_message(
    auth: AuthUser,
    Path((_channel_id, message_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?")
        .bind(&auth.0)
        .bind(&message_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/@me/saved — your bookmarks, most-recently-saved first.
pub async fn list_saved(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<MessageWithAuthor>>, (StatusCode, String)> {
    // The FK cascade means saved rows always point at live messages.
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT message_id FROM saved_messages WHERE user_id = ? ORDER BY saved_at DESC LIMIT 100",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;

    let mut out = Vec::with_capacity(ids.len());
    for (mid,) in ids {
        let msg: Option<Message> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
            .bind(&mid)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
        if let Some(msg) = msg {
            out.push(build_full(&state, msg, &auth.0).await?);
        }
    }
    Ok(Json(out))
}
