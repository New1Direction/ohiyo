//! Threads: a reply chain started from one message in a space's text channel.
//!
//! A thread is a channel row with `parent_id` (the channel it hangs off) and
//! `thread_message_id` (the message it started from), in the same space. Everything else is
//! the ordinary channel machinery: messages, reactions, pins, edits, search and gateway
//! delivery all work on the thread's id, and its permissions are its parent's (see
//! [`crate::api::roles::channel_permissions`]). Threads are left out of the space's channel
//! list; they're listed per channel here, and a `ThreadUpdate` tells everyone who can see
//! the channel when one starts or its message count changes. DMs and group chats are
//! end-to-end encrypted and have no threads.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_channel,
    types::{new_id, now_unix, Channel, GatewayEvent, ThreadSummary},
    AppState,
};

/// How many threads one account may start a minute.
const THREADS_PER_MINUTE: usize = 10;
/// The most threads a channel's list returns, busiest first.
const LIST_LIMIT: i64 = 100;
/// A name made from the message stops at this many characters.
const DERIVED_NAME_CHARS: usize = 100;

#[derive(sqlx::FromRow)]
struct ThreadRow {
    #[sqlx(flatten)]
    channel: Channel,
    message_count: i64,
    last_message_at: Option<i64>,
    starter_deleted: bool,
}

impl From<ThreadRow> for ThreadSummary {
    fn from(row: ThreadRow) -> Self {
        ThreadSummary {
            channel: row.channel,
            message_count: row.message_count,
            last_message_at: row.last_message_at,
            starter_deleted: row.starter_deleted,
        }
    }
}

const SUMMARY_COLUMNS: &str = "c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at,
    (c.thread_message_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id = c.thread_message_id)) AS starter_deleted";

/// One thread's summary, or None when `thread_id` isn't a thread.
pub async fn thread_summary(
    state: &AppState,
    thread_id: &str,
) -> Result<Option<ThreadSummary>, sqlx::Error> {
    let row: Option<ThreadRow> = sqlx::query_as(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM channels c WHERE c.id = ? AND c.parent_id IS NOT NULL"
    ))
    .bind(thread_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(ThreadSummary::from))
}

/// Tell everyone who can see a thread's channel where the thread stands now.
pub async fn announce(state: &AppState, thread_id: &str) {
    match thread_summary(state, thread_id).await {
        Ok(Some(summary)) => {
            let Some(parent) = summary.channel.parent_id.clone() else {
                return;
            };
            broadcast_to_channel(state, &parent, &GatewayEvent::ThreadUpdate(summary)).await;
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("couldn't read thread {thread_id} to announce it: {e}"),
    }
}

/// A message was deleted from `channel_id`. If that channel is a thread its count changed;
/// if the message started a thread, that thread now has no first message.
pub async fn after_message_deleted(state: &AppState, channel_id: &str, message_id: &str) {
    if crate::api::roles::thread_parent(state, channel_id)
        .await
        .is_some()
    {
        announce(state, channel_id).await;
    }
    let started: Option<String> =
        sqlx::query_scalar("SELECT id FROM channels WHERE thread_message_id = ?")
            .bind(message_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("couldn't look for the thread of message {message_id}: {e}");
                None
            });
    if let Some(thread_id) = started {
        announce(state, &thread_id).await;
    }
}

/// The name a thread gets when none is given: the first line of its message.
fn name_from_message(content: &str) -> String {
    let line = content
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let name: String = line.chars().take(DERIVED_NAME_CHARS).collect();
    if name.is_empty() {
        "Thread".to_owned()
    } else {
        name
    }
}

#[derive(Deserialize)]
pub struct CreateThreadBody {
    pub message_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// POST /channels/{channel_id}/threads — start a thread from a message in this channel.
/// Asking again for a message that already has one returns that thread.
pub async fn create_thread(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateThreadBody>,
) -> Result<Json<ThreadSummary>, (StatusCode, String)> {
    let parent: Channel = sqlx::query_as("SELECT * FROM channels WHERE id = ?")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?
        .ok_or((StatusCode::NOT_FOUND, "channel not found".into()))?;
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let Some(server_id) = parent.server_id.clone() else {
        return Err((
            StatusCode::BAD_REQUEST,
            "threads are for a space's text channels".into(),
        ));
    };
    if parent.parent_id.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "a thread can't have threads of its own".into(),
        ));
    }
    if parent.channel_type != "text" {
        return Err((
            StatusCode::BAD_REQUEST,
            "threads are for a space's text channels".into(),
        ));
    }
    if !crate::api::roles::has_channel_perm(
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
    let content: String =
        sqlx::query_scalar("SELECT content FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&body.message_id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?
            .ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    let given = body.name.as_deref().map(str::trim).unwrap_or_default();
    crate::api::limits::check_len("thread name", given, crate::api::limits::THREAD_NAME)?;
    let name = if given.is_empty() {
        name_from_message(&content)
    } else {
        given.to_owned()
    };

    if let Some(existing) = existing_thread(&state, &body.message_id).await? {
        return Ok(Json(existing));
    }
    if !state.rate.check(
        &format!("thread:{}", auth.0),
        THREADS_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're starting threads too fast".into(),
        ));
    }

    let id = new_id();
    let inserted = sqlx::query(
        "INSERT INTO channels
           (id, server_id, name, channel_type, position, created_at, parent_id, thread_message_id)
         VALUES (?, ?, ?, 'text', 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&name)
    .bind(now_unix())
    .bind(&channel_id)
    .bind(&body.message_id)
    .execute(&state.db)
    .await;
    if let Err(e) = inserted {
        // Two people started a thread on the same message at once: the other one won.
        if let Some(existing) = existing_thread(&state, &body.message_id).await? {
            return Ok(Json(existing));
        }
        return Err(crate::api::error::internal(e));
    }

    let summary = thread_summary(&state, &id)
        .await
        .map_err(crate::api::error::internal)?
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "thread vanished".into()))?;
    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::ThreadUpdate(summary.clone()),
    )
    .await;
    Ok(Json(summary))
}

async fn existing_thread(
    state: &AppState,
    message_id: &str,
) -> Result<Option<ThreadSummary>, (StatusCode, String)> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT id FROM channels WHERE thread_message_id = ?")
            .bind(message_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    match id {
        Some(id) => thread_summary(state, &id)
            .await
            .map_err(crate::api::error::internal),
        None => Ok(None),
    }
}

/// GET /channels/{channel_id}/threads — the channel's threads, latest activity first.
pub async fn list_threads(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<ThreadSummary>>, (StatusCode, String)> {
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let rows: Vec<ThreadRow> = sqlx::query_as(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM channels c
         WHERE c.parent_id = ?
         ORDER BY COALESCE(
                    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
                    c.created_at
                  ) DESC,
                  c.created_at DESC,
                  c.id
         LIMIT ?"
    ))
    .bind(&channel_id)
    .bind(LIST_LIMIT)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows.into_iter().map(ThreadSummary::from).collect()))
}

#[cfg(test)]
mod tests {
    use super::name_from_message;

    #[test]
    fn a_thread_is_named_after_the_first_line_of_its_message() {
        assert_eq!(
            name_from_message("Plans for Saturday\nand more"),
            "Plans for Saturday"
        );
        assert_eq!(
            name_from_message("  \n   lots   of   space  "),
            "lots of space"
        );
        assert_eq!(name_from_message(""), "Thread");
        assert_eq!(name_from_message(&"é".repeat(150)).chars().count(), 100);
    }
}
