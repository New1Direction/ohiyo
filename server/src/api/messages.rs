use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_channel,
    types::{
        GatewayEvent, Message, MessageWithAuthor, PublicUser, ReactionGroup, ReplyPreview, User,
        new_id, now_unix,
    },
    AppState,
};

const REPLY_SNIPPET_LEN: usize = 120;

/// Resolve a compact preview (author + truncated content) for a replied-to message.
async fn fetch_reply_preview(db: &sqlx::SqlitePool, reply_id: &str) -> Option<ReplyPreview> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT u.display_name, m.content
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.id = ?",
    )
    .bind(reply_id)
    .fetch_optional(db)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("fetch_reply_preview failed for {reply_id}: {e}");
        None
    });

    row.map(|(author, content)| {
        let snippet: String = content.chars().take(REPLY_SNIPPET_LEN).collect();
        let content = if snippet.chars().count() < content.chars().count() {
            format!("{snippet}…")
        } else {
            snippet
        };
        ReplyPreview { id: reply_id.to_string(), author, content }
    })
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    pub before: Option<String>,
}

fn default_limit() -> i64 {
    50
}

#[derive(sqlx::FromRow)]
struct ReactionRow {
    emoji: String,
    count: i64,
    me: i64,
}

async fn fetch_reactions(db: &sqlx::SqlitePool, message_id: &str, user_id: &str) -> Vec<ReactionGroup> {
    let rows: Vec<ReactionRow> = sqlx::query_as(
        "SELECT emoji, COUNT(*) as count,
                MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
         FROM reactions WHERE message_id = ?
         GROUP BY emoji
         ORDER BY MIN(created_at)",
    )
    .bind(user_id)
    .bind(message_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|r| ReactionGroup { emoji: r.emoji, count: r.count, me: r.me != 0 })
        .collect()
}

pub async fn list_messages(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Query(q): Query<ListQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MessageWithAuthor>>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let limit = q.limit.min(100);

    let messages: Vec<Message> = if let Some(before) = q.before {
        // Cursor by time — ids are random UUID v4, so `id < ?` is NOT time-ordered.
        sqlx::query_as(
            "SELECT * FROM messages
             WHERE channel_id = ?
               AND created_at < (SELECT created_at FROM messages WHERE id = ?)
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(&channel_id)
        .bind(&before)
        .bind(limit)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as(
            "SELECT * FROM messages WHERE channel_id = ?
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(&channel_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await
    }
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // N+1 (author + reactions + reply preview per message) — acceptable on
    // in-process SQLite at limit≤100; batch with JOINs if profiling shows contention.
    let mut out = Vec::with_capacity(messages.len());
    for msg in messages {
        let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
            .bind(&msg.author_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let reactions = fetch_reactions(&state.db, &msg.id, &auth.0).await;
        let reply_to = match &msg.reply_to {
            Some(rid) => fetch_reply_preview(&state.db, rid).await,
            None => None,
        };
        let poll = crate::api::polls::fetch_poll(&state.db, &msg.id, &auth.0).await;

        out.push(MessageWithAuthor {
            pinned: msg.pinned != 0,
            id: msg.id,
            channel_id: msg.channel_id,
            author: PublicUser::from(author),
            content: msg.content,
            created_at: msg.created_at,
            edited_at: msg.edited_at,
            attachments: parse_attachments(&msg.attachments),
            reactions,
            reply_to,
            poll,
        });
    }

    // Return oldest-first.
    out.reverse();
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct SendMessageBody {
    pub content: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// Optional id of a message in this channel being replied to.
    #[serde(default)]
    pub reply_to: Option<String>,
}

#[derive(Serialize)]
struct AttachmentMeta {
    id: String,
    filename: String,
    content_type: String,
    size_bytes: i64,
    width: Option<i64>,
    height: Option<i64>,
}

/// Parse the stored attachments JSON string into an array value for API responses.
fn parse_attachments(raw: &Option<String>) -> Option<serde_json::Value> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

pub async fn send_message(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<SendMessageBody>,
) -> Result<Json<MessageWithAuthor>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    // Per-user spam throttle (generous for humans, blocks flooders).
    if !state.rate.check(&format!("msg:{}", auth.0), 30, Duration::from_secs(10)) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "you're sending messages too fast".into()));
    }
    if body.content.len() > 4000 {
        return Err((StatusCode::BAD_REQUEST, "message too long (max 4000 chars)".into()));
    }
    if body.content.trim().is_empty() && body.attachment_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "content or attachments required".into()));
    }

    let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&auth.0)
        .fetch_one(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Look up attachment metadata and build JSON.
    let attachments_json = if body.attachment_ids.is_empty() {
        None
    } else {
        let mut metas: Vec<AttachmentMeta> = Vec::new();
        for file_id in &body.attachment_ids {
            let row: Option<(String, String, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
                "SELECT filename, content_type, size_bytes, width, height FROM files WHERE id = ?",
            )
            .bind(file_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            if let Some((filename, content_type, size_bytes, width, height)) = row {
                metas.push(AttachmentMeta {
                    id: file_id.clone(),
                    filename,
                    content_type,
                    size_bytes,
                    width,
                    height,
                });
            }
        }
        Some(serde_json::to_string(&metas).unwrap_or_default())
    };

    let id = new_id();
    let now = now_unix();
    let content = body.content.trim().to_owned();

    // Only honour a reply target that actually exists in this channel.
    let reply_to: Option<String> = match body.reply_to.filter(|s| !s.is_empty()) {
        Some(rid) => {
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT id FROM messages WHERE id = ? AND channel_id = ?")
                    .bind(&rid)
                    .bind(&channel_id)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            exists.map(|_| rid)
        }
        None => None,
    };

    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, attachments, reply_to) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&channel_id)
    .bind(&auth.0)
    .bind(&content)
    .bind(now)
    .bind(&attachments_json)
    .bind(&reply_to)
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let reply_preview = match &reply_to {
        Some(rid) => fetch_reply_preview(&state.db, rid).await,
        None => None,
    };

    let msg = MessageWithAuthor {
        id,
        channel_id,
        author: PublicUser::from(author),
        content,
        created_at: now,
        edited_at: None,
        attachments: parse_attachments(&attachments_json),
        reactions: vec![],
        reply_to: reply_preview,
        pinned: false,
        poll: None,
    };

    broadcast_to_channel(&state, &msg.channel_id, &GatewayEvent::MessageCreate(msg.clone())).await;
    Ok(Json(msg))
}

// ── Edit / pin ────────────────────────────────────────────────────────────────

/// Rebuild a full message-with-author payload (author, reactions, reply, poll).
pub async fn build_full(
    state: &AppState,
    msg: Message,
    viewer_id: &str,
) -> Result<MessageWithAuthor, (StatusCode, String)> {
    let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&msg.author_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let reactions = fetch_reactions(&state.db, &msg.id, viewer_id).await;
    let reply_to = match &msg.reply_to {
        Some(rid) => fetch_reply_preview(&state.db, rid).await,
        None => None,
    };
    let poll = crate::api::polls::fetch_poll(&state.db, &msg.id, viewer_id).await;
    Ok(MessageWithAuthor {
        pinned: msg.pinned != 0,
        id: msg.id,
        channel_id: msg.channel_id,
        author: PublicUser::from(author),
        content: msg.content,
        created_at: msg.created_at,
        edited_at: msg.edited_at,
        attachments: parse_attachments(&msg.attachments),
        reactions,
        reply_to,
        poll,
    })
}

/// True if the user can see (and therefore act in) a channel.
pub async fn user_can_access(state: &AppState, channel_id: &str, user_id: &str) -> bool {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let server_id = row.and_then(|(s,)| s);
    let found: Option<(i64,)> = match server_id {
        Some(sid) => sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(sid)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten(),
        None => sqlx::query_as("SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ?")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten(),
    };
    found.is_some()
}

/// One participant's read cursor in a channel.
#[derive(Serialize)]
pub struct ReadCursor {
    pub user_id: String,
    pub last_read_message_id: Option<String>,
    pub last_read_at: i64,
}

/// All read cursors for a channel — used to hydrate Delivered/Seen receipts when
/// a DM is opened (live updates then arrive via the ReadReceipt gateway event).
pub async fn list_reads(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<ReadCursor>>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "No access to this channel".into()));
    }
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT user_id, last_read_message_id, last_read_at FROM channel_reads WHERE channel_id = ?",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let cursors = rows
        .into_iter()
        .map(|(user_id, last_read_message_id, last_read_at)| ReadCursor {
            user_id,
            last_read_message_id,
            last_read_at,
        })
        .collect();
    Ok(Json(cursors))
}

#[derive(Deserialize)]
pub struct EditMessageBody {
    pub content: String,
}

/// PATCH /channels/{channel_id}/messages/{id} — author edits their own message.
pub async fn edit_message(
    auth: AuthUser,
    Path((channel_id, id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<EditMessageBody>,
) -> Result<Json<MessageWithAuthor>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let content = body.content.trim().to_owned();
    if content.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "content required".into()));
    }
    if content.len() > 4000 {
        return Err((StatusCode::BAD_REQUEST, "message too long (max 4000 chars)".into()));
    }

    let msg: Option<Message> =
        sqlx::query_as("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    if msg.author_id != auth.0 {
        return Err((StatusCode::FORBIDDEN, "not your message".into()));
    }

    let now = now_unix();
    sqlx::query("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?")
        .bind(&content)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let updated = Message { content, edited_at: Some(now), ..msg };
    let full = build_full(&state, updated, &auth.0).await?;
    broadcast_to_channel(&state, &channel_id, &GatewayEvent::MessageUpdate(full.clone())).await;
    Ok(Json(full))
}

async fn set_pin(
    state: &AppState,
    channel_id: &str,
    id: &str,
    user_id: &str,
    pinned: bool,
) -> Result<Json<MessageWithAuthor>, (StatusCode, String)> {
    if !user_can_access(state, channel_id, user_id).await {
        return Err((StatusCode::FORBIDDEN, "you can't pin here".into()));
    }
    // Pinning in a server channel requires MANAGE_MESSAGES (DM pins are unrestricted).
    let chan: Option<(Option<String>,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some((Some(sid),)) = chan {
        if !crate::api::roles::has_perm(state, &sid, user_id, crate::api::roles::perm::MANAGE_MESSAGES).await {
            return Err((StatusCode::FORBIDDEN, "you need Manage Messages to pin".into()));
        }
    }
    let msg: Option<Message> =
        sqlx::query_as("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
            .bind(id)
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    let flag = if pinned { 1 } else { 0 };
    sqlx::query("UPDATE messages SET pinned = ? WHERE id = ?")
        .bind(flag)
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let updated = Message { pinned: flag, ..msg };
    let full = build_full(state, updated, user_id).await?;
    broadcast_to_channel(state, channel_id, &GatewayEvent::MessageUpdate(full.clone())).await;
    Ok(Json(full))
}

/// POST /channels/{channel_id}/messages/{id}/pin
pub async fn pin_message(
    auth: AuthUser,
    Path((channel_id, id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<MessageWithAuthor>, (StatusCode, String)> {
    set_pin(&state, &channel_id, &id, &auth.0, true).await
}

/// DELETE /channels/{channel_id}/messages/{id}/pin
pub async fn unpin_message(
    auth: AuthUser,
    Path((channel_id, id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<MessageWithAuthor>, (StatusCode, String)> {
    set_pin(&state, &channel_id, &id, &auth.0, false).await
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// GET /servers/{server_id}/search?q=… — full-text-ish search across a server's
/// channels (members only). Returns newest-first matches with author + channel.
pub async fn search_messages(
    auth: AuthUser,
    Path(server_id): Path<String>,
    Query(query): Query<SearchQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MessageWithAuthor>>, (StatusCode, String)> {
    let member: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(&server_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if member.is_none() {
        return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
    }

    let term = query.q.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    let messages: Vec<Message> = sqlx::query_as(
        "SELECT m.* FROM messages m
         JOIN channels c ON c.id = m.channel_id
         WHERE c.server_id = ? AND m.content LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC LIMIT 50",
    )
    .bind(&server_id)
    .bind(&pattern)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut out = Vec::with_capacity(messages.len());
    for msg in messages {
        out.push(build_full(&state, msg, &auth.0).await?);
    }
    Ok(Json(out))
}

/// GET /channels/{channel_id}/pins — pinned messages, newest first.
pub async fn list_pins(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MessageWithAuthor>>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let messages: Vec<Message> = sqlx::query_as(
        "SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY created_at DESC",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut out = Vec::with_capacity(messages.len());
    for msg in messages {
        out.push(build_full(&state, msg, &auth.0).await?);
    }
    Ok(Json(out))
}

pub async fn delete_message(
    auth: AuthUser,
    Path((channel_id, id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let msg: Option<Message> =
        sqlx::query_as("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    if msg.author_id != auth.0 {
        // Mods with MANAGE_MESSAGES can delete others' messages in a server channel.
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT server_id FROM channels WHERE id = ?")
                .bind(&channel_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        let can = match row.and_then(|(s,)| s) {
            Some(sid) => {
                crate::api::roles::has_perm(&state, &sid, &auth.0, crate::api::roles::perm::MANAGE_MESSAGES).await
            }
            None => false,
        };
        if !can {
            return Err((StatusCode::FORBIDDEN, "not your message".into()));
        }
    }

    sqlx::query("DELETE FROM messages WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::MessageDelete { id, channel_id: channel_id.clone() },
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
