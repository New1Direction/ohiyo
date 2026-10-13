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
//!
//! Whoever started a thread, or anyone who manages the channel's messages or channels, can
//! rename or delete it. You follow a thread when you start it or reply in it, and can follow
//! or unfollow it by hand: a followed thread counts as unread and notifies like a channel
//! (under its channel's notification settings), the rest only on an @mention. A thread
//! nobody has written in for a week reads as archived until someone does.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    gateway::{broadcast_to_channel, broadcast_to_user},
    types::{new_id, now_unix, Channel, GatewayEvent, ThreadSummary},
    AppState,
};

type ApiError = (StatusCode, String);

/// How many threads one account may start a minute.
const THREADS_PER_MINUTE: usize = 10;
/// The most threads a channel's list returns, busiest first.
const LIST_LIMIT: i64 = 100;
/// A name made from the message stops at this many characters.
const DERIVED_NAME_CHARS: usize = 100;
/// A thread nobody has written in for this long reads as archived.
pub const ARCHIVE_AFTER_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Renames, deletes, follows and unfollows per account per minute.
const CHANGES_PER_MINUTE: usize = 60;

#[derive(sqlx::FromRow)]
struct ThreadRow {
    #[sqlx(flatten)]
    channel: Channel,
    message_count: i64,
    last_message_at: Option<i64>,
    starter_deleted: bool,
    owner_id: Option<String>,
    /// Only when the query asks whether the reader follows it.
    #[sqlx(default)]
    following: Option<bool>,
}

/// Nobody has written in it for a week (or, with no replies, since it started a week ago).
fn archived(last_message_at: Option<i64>, created_at: i64, now: i64) -> bool {
    last_message_at.unwrap_or(created_at) <= now - ARCHIVE_AFTER_SECONDS
}

impl From<ThreadRow> for ThreadSummary {
    fn from(row: ThreadRow) -> Self {
        ThreadSummary {
            archived: archived(row.last_message_at, row.channel.created_at, now_unix()),
            channel: row.channel,
            message_count: row.message_count,
            last_message_at: row.last_message_at,
            starter_deleted: row.starter_deleted,
            owner_id: row.owner_id,
            following: row.following,
        }
    }
}

const SUMMARY_COLUMNS: &str = "c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at,
    (c.thread_message_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id = c.thread_message_id)) AS starter_deleted,
    c.thread_owner_id AS owner_id";

/// Whether `?` (a user id, bound first) follows the thread `c`.
const FOLLOWING_COLUMN: &str =
    "EXISTS (SELECT 1 FROM thread_follows f WHERE f.thread_id = c.id AND f.user_id = ?) AS following";

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

    if let Some(existing) = existing_thread(&state, &body.message_id, &auth.0).await? {
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
           (id, server_id, name, channel_type, position, created_at, parent_id, thread_message_id,
            thread_owner_id)
         VALUES (?, ?, ?, 'text', 0, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&name)
    .bind(now_unix())
    .bind(&channel_id)
    .bind(&body.message_id)
    .bind(&auth.0)
    .execute(&state.db)
    .await;
    if let Err(e) = inserted {
        // Two people started a thread on the same message at once: the other one won.
        if let Some(existing) = existing_thread(&state, &body.message_id, &auth.0).await? {
            return Ok(Json(existing));
        }
        return Err(crate::api::error::internal(e));
    }
    // Starting a thread follows it.
    follow_quietly(&state, &auth.0, &id).await;

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
    Ok(Json(ThreadSummary {
        following: Some(true),
        ..summary
    }))
}

async fn existing_thread(
    state: &AppState,
    message_id: &str,
    reader: &str,
) -> Result<Option<ThreadSummary>, ApiError> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT id FROM channels WHERE thread_message_id = ?")
            .bind(message_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    match id {
        Some(id) => summary_for(state, &id, reader)
            .await
            .map_err(crate::api::error::internal),
        None => Ok(None),
    }
}

/// One thread as `reader` sees it: its summary plus whether they follow it.
async fn summary_for(
    state: &AppState,
    thread_id: &str,
    reader: &str,
) -> Result<Option<ThreadSummary>, sqlx::Error> {
    let row: Option<ThreadRow> = sqlx::query_as(&format!(
        "SELECT {SUMMARY_COLUMNS}, {FOLLOWING_COLUMN}
         FROM channels c WHERE c.id = ? AND c.parent_id IS NOT NULL"
    ))
    .bind(reader)
    .bind(thread_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(ThreadSummary::from))
}

/// The threads `user_id` follows, each with `following: true`. The caller keeps only those
/// in channels the person can see.
pub async fn followed_by(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<ThreadSummary>, sqlx::Error> {
    let rows: Vec<ThreadRow> = sqlx::query_as(&format!(
        "SELECT {SUMMARY_COLUMNS}, 1 AS following
         FROM channels c JOIN thread_follows tf ON tf.thread_id = c.id
         WHERE tf.user_id = ? AND c.parent_id IS NOT NULL"
    ))
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(ThreadSummary::from).collect())
}

/// The thread with this id when the caller can see it; 404 otherwise (an ordinary channel,
/// a thread that's gone, or one in a channel they can't see all look the same).
async fn visible_thread(
    state: &AppState,
    thread_id: &str,
    user_id: &str,
) -> Result<Channel, ApiError> {
    let thread: Option<Channel> =
        sqlx::query_as("SELECT * FROM channels WHERE id = ? AND parent_id IS NOT NULL")
            .bind(thread_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    match thread {
        Some(thread) if crate::api::messages::user_can_access(state, thread_id, user_id).await => {
            Ok(thread)
        }
        _ => Err((StatusCode::NOT_FOUND, "thread not found".into())),
    }
}

/// Whoever started the thread, or someone who manages the channel's messages or channels
/// (a thread takes its channel's permissions).
async fn may_manage(state: &AppState, thread_id: &str, user_id: &str) -> bool {
    let owner: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT thread_owner_id FROM channels WHERE id = ?",
    )
    .bind(thread_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .flatten();
    if owner.as_deref() == Some(user_id) {
        return true;
    }
    use crate::api::roles::{has_channel_perm, perm};
    has_channel_perm(state, thread_id, user_id, perm::MANAGE_MESSAGES).await
        || has_channel_perm(state, thread_id, user_id, perm::MANAGE_CHANNELS).await
}

fn within_change_budget(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.rate.check(
        &format!("thread-change:{user_id}"),
        CHANGES_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        Ok(())
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're changing threads too fast".into(),
        ))
    }
}

#[derive(Deserialize)]
pub struct RenameThreadBody {
    pub name: String,
}

/// PATCH /threads/{id} — rename a thread (its starter, or someone who manages the channel).
pub async fn rename_thread(
    auth: AuthUser,
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<RenameThreadBody>,
) -> Result<Json<ThreadSummary>, ApiError> {
    visible_thread(&state, &thread_id, &auth.0).await?;
    if !may_manage(&state, &thread_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "only whoever started this thread, or someone who manages the channel, can rename it"
                .into(),
        ));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "a thread needs a name".into()));
    }
    crate::api::limits::check_len("thread name", name, crate::api::limits::THREAD_NAME)?;
    within_change_budget(&state, &auth.0)?;
    sqlx::query("UPDATE channels SET name = ? WHERE id = ?")
        .bind(name)
        .bind(&thread_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    announce(&state, &thread_id).await;
    summary_for(&state, &thread_id, &auth.0)
        .await
        .map_err(crate::api::error::internal)?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "thread not found".into()))
}

/// DELETE /threads/{id} — delete a thread and its messages (its starter, or someone who
/// manages the channel). The files its messages held are freed; everyone watching the
/// channel hears it went.
pub async fn delete_thread(
    auth: AuthUser,
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    let thread = visible_thread(&state, &thread_id, &auth.0).await?;
    if !may_manage(&state, &thread_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "only whoever started this thread, or someone who manages the channel, can delete it"
                .into(),
        ));
    }
    within_change_budget(&state, &auth.0)?;
    let mut conn = state
        .db
        .acquire()
        .await
        .map_err(crate::api::error::internal)?;
    let files = crate::api::files::files_of_channel(&mut conn, &thread_id)
        .await
        .map_err(crate::api::error::internal)?;
    drop(conn);
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(crate::api::error::internal)?;
    crate::api::notifications::forget_channel(&mut *tx, &thread_id)
        .await
        .map_err(crate::api::error::internal)?;
    sqlx::query("DELETE FROM channel_reads WHERE channel_id = ?")
        .bind(&thread_id)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    // Its messages (and their reactions and pins) and its followers go with it.
    let gone = sqlx::query("DELETE FROM channels WHERE id = ? AND parent_id IS NOT NULL")
        .bind(&thread_id)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?
        .rows_affected();
    tx.commit().await.map_err(crate::api::error::internal)?;
    if gone == 0 {
        return Err((StatusCode::NOT_FOUND, "thread not found".into()));
    }
    crate::api::files::release_files_in_batches(&state.db, &files).await;
    if let Some(parent_id) = thread.parent_id {
        broadcast_to_channel(
            &state,
            &parent_id,
            &GatewayEvent::ThreadDelete {
                id: thread_id,
                parent_id: parent_id.clone(),
                thread_message_id: thread.thread_message_id,
            },
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /threads/{id}/follow — follow a thread: it counts as unread and notifies like a channel.
pub async fn follow_thread(
    auth: AuthUser,
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    set_follow(&state, &auth.0, &thread_id, true).await
}

/// DELETE /threads/{id}/follow — stop following: only an @mention notifies again.
pub async fn unfollow_thread(
    auth: AuthUser,
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    set_follow(&state, &auth.0, &thread_id, false).await
}

async fn set_follow(
    state: &AppState,
    user_id: &str,
    thread_id: &str,
    on: bool,
) -> Result<StatusCode, ApiError> {
    visible_thread(state, thread_id, user_id).await?;
    within_change_budget(state, user_id)?;
    let change = if on {
        sqlx::query(
            "INSERT OR IGNORE INTO thread_follows (user_id, thread_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(user_id)
        .bind(thread_id)
        .bind(now_unix())
    } else {
        sqlx::query("DELETE FROM thread_follows WHERE user_id = ? AND thread_id = ?")
            .bind(user_id)
            .bind(thread_id)
    };
    change
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    tell_devices(state, user_id, thread_id, on).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Follow a thread without being asked (starting it, replying in it). Only a new follow is
/// told to the person's other devices.
pub async fn follow_quietly(state: &AppState, user_id: &str, thread_id: &str) {
    let added = sqlx::query(
        "INSERT OR IGNORE INTO thread_follows (user_id, thread_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(user_id)
    .bind(thread_id)
    .bind(now_unix())
    .execute(&state.db)
    .await;
    match added {
        Ok(done) if done.rows_affected() == 1 => {
            tell_devices(state, user_id, thread_id, true).await
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("couldn't follow thread {thread_id} for {user_id}: {e}"),
    }
}

/// Tell the person's open devices they follow (or don't follow) a thread now.
async fn tell_devices(state: &AppState, user_id: &str, thread_id: &str, following: bool) {
    match thread_summary(state, thread_id).await {
        Ok(Some(summary)) => broadcast_to_user(
            &state.sessions,
            user_id,
            &GatewayEvent::ThreadFollowUpdate {
                thread: ThreadSummary {
                    following: Some(following),
                    ..summary
                },
                following,
            },
        ),
        Ok(None) => {}
        Err(e) => {
            tracing::warn!("couldn't read thread {thread_id} to tell {user_id}'s devices: {e}")
        }
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
        "SELECT {SUMMARY_COLUMNS}, {FOLLOWING_COLUMN} FROM channels c
         WHERE c.parent_id = ?
         ORDER BY COALESCE(
                    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
                    c.created_at
                  ) DESC,
                  c.created_at DESC,
                  c.id
         LIMIT ?"
    ))
    .bind(&auth.0)
    .bind(&channel_id)
    .bind(LIST_LIMIT)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows.into_iter().map(ThreadSummary::from).collect()))
}

#[cfg(test)]
mod tests {
    use super::{archived, name_from_message, ARCHIVE_AFTER_SECONDS};

    #[test]
    fn a_thread_is_archived_a_week_after_its_last_message() {
        let now = 10_000_000;
        assert!(
            !archived(Some(now - 60), now - 30 * 86_400, now),
            "a recent reply"
        );
        assert!(archived(
            Some(now - ARCHIVE_AFTER_SECONDS),
            now - 30 * 86_400,
            now
        ));
        assert!(
            !archived(None, now - 60, now),
            "a new thread with no replies yet"
        );
        assert!(
            archived(None, now - ARCHIVE_AFTER_SECONDS - 1, now),
            "a week with no replies"
        );
    }

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
