use axum::{
    extract::{Path, State},
    http::StatusCode,
};

use crate::{
    api::messages::user_can_access,
    auth::AuthUser,
    gateway::broadcast_to_channel,
    types::{now_unix, GatewayEvent},
    AppState,
};

pub async fn toggle_reaction(
    auth: AuthUser,
    Path((channel_id, message_id, emoji)): Path<(String, String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Broken-access-control fix: you must be a member of (or DM participant in) the channel.
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    crate::api::moderation::ensure_not_timed_out_in_channel(&state, &channel_id, &auth.0).await?;
    // Count chars, not bytes, so multi-codepoint emoji (family, skin tone) aren't rejected.
    if emoji.is_empty() || emoji.chars().count() > 8 {
        return Err((StatusCode::BAD_REQUEST, "invalid emoji".into()));
    }
    // channel_id is attacker-controlled — confirm the message actually lives in it.
    let belongs: Option<(Option<String>,)> =
        sqlx::query_as("SELECT call_log FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&message_id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let Some((call_log,)) = belongs else {
        return Err((StatusCode::NOT_FOUND, "message not found".into()));
    };
    if call_log.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "a call log can't be reacted to".into(),
        ));
    }

    // Look and toggle in one write transaction: taps at once would otherwise all see no
    // reaction, and every insert after the first would fail. BEGIN IMMEDIATE takes the
    // write lock before the look, so each tap sees the one before it.
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(crate::api::error::internal)?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
    )
    .bind(&message_id)
    .bind(&auth.0)
    .bind(&emoji)
    .fetch_one(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;

    let added = if existing > 0 {
        sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
            .bind(&message_id)
            .bind(&auth.0)
            .bind(&emoji)
            .execute(&mut *tx)
            .await
            .map_err(crate::api::error::internal)?;
        false
    } else {
        sqlx::query(
            "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)",
        )
        .bind(&message_id)
        .bind(&auth.0)
        .bind(&emoji)
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
        true
    };
    tx.commit().await.map_err(crate::api::error::internal)?;

    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::ReactionUpdate {
            message_id,
            channel_id: channel_id.clone(),
            emoji,
            user_id: auth.0,
            added,
        },
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
