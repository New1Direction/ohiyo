use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::{
    api::messages::{build_full, user_can_access},
    auth::AuthUser,
    gateway::broadcast_to_channel,
    types::{new_id, now_unix, GatewayEvent, Message, Poll, PollOption},
    AppState,
};

/// Resolve a message's poll (options, vote counts, whether the viewer voted).
pub async fn fetch_poll(db: &SqlitePool, message_id: &str, viewer_id: &str) -> Option<Poll> {
    let (question, multi, closes_at): (String, i64, Option<i64>) =
        sqlx::query_as("SELECT question, multi, closes_at FROM polls WHERE message_id = ?")
            .bind(message_id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()?;

    let opt_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, text FROM poll_options WHERE message_id = ? ORDER BY position")
            .bind(message_id)
            .fetch_all(db)
            .await
            .unwrap_or_default();

    let mut options = Vec::with_capacity(opt_rows.len());
    let mut total = 0i64;
    for (id, text) in opt_rows {
        let votes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM poll_votes WHERE option_id = ?")
            .bind(&id)
            .fetch_one(db)
            .await
            .unwrap_or(0);
        let me: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM poll_votes WHERE option_id = ? AND user_id = ?",
        )
        .bind(&id)
        .bind(viewer_id)
        .fetch_one(db)
        .await
        .unwrap_or(0);
        total += votes;
        options.push(PollOption {
            id,
            text,
            votes,
            me: me > 0,
        });
    }

    Some(Poll {
        question,
        multi: multi != 0,
        closes_at,
        total_votes: total,
        options,
    })
}

#[derive(Deserialize)]
pub struct CreatePollBody {
    pub question: String,
    pub options: Vec<String>,
    #[serde(default)]
    pub multi: bool,
    #[serde(default)]
    pub closes_in_secs: Option<i64>,
}

/// POST /channels/{channel_id}/polls — start a poll (lands as a message).
pub async fn create_poll(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreatePollBody>,
) -> Result<Json<crate::types::MessageWithAuthor>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    if server_id.is_some()
        && !crate::api::roles::has_channel_perm(
            &state,
            &channel_id,
            &auth.0,
            crate::api::roles::perm::SEND_MESSAGES,
        )
        .await
    {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't send messages in this channel".into(),
        ));
    }
    if !state
        .rate
        .check(&format!("msg:{}", auth.0), 30, Duration::from_secs(10))
    {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down a moment".into()));
    }

    let question = body.question.trim().to_owned();
    if question.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "ask a question".into()));
    }
    let options: Vec<String> = body
        .options
        .into_iter()
        .map(|o| o.trim().to_owned())
        .filter(|o| !o.is_empty())
        .collect();
    if options.len() < 2 || options.len() > 10 {
        return Err((StatusCode::BAD_REQUEST, "polls need 2–10 options".into()));
    }

    let now = now_unix();
    let message_id = new_id();
    let closes_at = body
        .closes_in_secs
        .filter(|s| *s > 0)
        .map(|s| now + s.min(60 * 60 * 24 * 30));

    // The poll rides on a normal message so it appears in the channel + search.
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&auth.0)
    .bind(&question)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    sqlx::query("INSERT INTO polls (message_id, question, multi, closes_at) VALUES (?,?,?,?)")
        .bind(&message_id)
        .bind(&question)
        .bind(if body.multi { 1 } else { 0 })
        .bind(closes_at)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    for (i, text) in options.iter().enumerate() {
        sqlx::query("INSERT INTO poll_options (id, message_id, text, position) VALUES (?,?,?,?)")
            .bind(new_id())
            .bind(&message_id)
            .bind(text)
            .bind(i as i64)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    }

    let msg: Message = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
        .bind(&message_id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let full = build_full(&state, msg, &auth.0).await?;
    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::MessageCreate(full.clone()),
    )
    .await;
    Ok(Json(full))
}

#[derive(Deserialize)]
pub struct VoteBody {
    pub option_id: String,
}

/// POST /channels/{channel_id}/polls/{message_id}/vote — cast/toggle a vote.
pub async fn vote_poll(
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<VoteBody>,
) -> Result<Json<crate::types::MessageWithAuthor>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }

    // The poll's message must live in the channel the access check ran against. Without
    // this, a user with access to one channel could pass a `message_id` from a channel
    // they can't see and vote on its poll (IDOR) — mirrors the guard in toggle_reaction.
    let in_channel: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&message_id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if in_channel.is_none() {
        return Err((StatusCode::NOT_FOUND, "poll not found".into()));
    }

    let poll: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT multi, closes_at FROM polls WHERE message_id = ?")
            .bind(&message_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let (multi, closes_at) = poll.ok_or((StatusCode::NOT_FOUND, "poll not found".into()))?;

    if closes_at.is_some_and(|c| c <= now_unix()) {
        return Err((StatusCode::FORBIDDEN, "this poll has closed".into()));
    }

    // Option must belong to this poll.
    let valid: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM poll_options WHERE id = ? AND message_id = ?")
            .bind(&body.option_id)
            .bind(&message_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    if valid.is_none() {
        return Err((StatusCode::BAD_REQUEST, "unknown option".into()));
    }

    // Did the user already pick this exact option? (toggle off)
    let had: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM poll_votes WHERE message_id = ? AND option_id = ? AND user_id = ?",
    )
    .bind(&message_id)
    .bind(&body.option_id)
    .bind(&auth.0)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    if had.is_some() {
        sqlx::query(
            "DELETE FROM poll_votes WHERE message_id = ? AND option_id = ? AND user_id = ?",
        )
        .bind(&message_id)
        .bind(&body.option_id)
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    } else {
        // Single-choice polls keep only one vote per user.
        if multi == 0 {
            sqlx::query("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?")
                .bind(&message_id)
                .bind(&auth.0)
                .execute(&state.db)
                .await
                .map_err(crate::api::error::internal)?;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO poll_votes (message_id, option_id, user_id) VALUES (?,?,?)",
        )
        .bind(&message_id)
        .bind(&body.option_id)
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    }

    let msg: Message = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
        .bind(&message_id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let full = build_full(&state, msg, &auth.0).await?;
    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::MessageUpdate(full.clone()),
    )
    .await;
    Ok(Json(full))
}
