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
        new_id, now_unix, GatewayEvent, Message, MessageWithAuthor, PublicUser, ReactionGroup,
        ReplyPreview, User,
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
        ReplyPreview {
            id: reply_id.to_string(),
            author,
            content,
        }
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

async fn fetch_reactions(
    db: &sqlx::SqlitePool,
    message_id: &str,
    user_id: &str,
) -> Vec<ReactionGroup> {
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
        .map(|r| ReactionGroup {
            emoji: r.emoji,
            count: r.count,
            me: r.me != 0,
        })
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

    // Never serve an already-expired disappearing message, even in the window before
    // the background sweeper physically deletes it.
    let now = now_unix();
    let messages: Vec<Message> = if let Some(before) = q.before {
        // Cursor by time — ids are random UUID v4, so `id < ?` is NOT time-ordered.
        sqlx::query_as(
            "SELECT * FROM messages
             WHERE channel_id = ?
               AND created_at < (SELECT created_at FROM messages WHERE id = ?)
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(&channel_id)
        .bind(&before)
        .bind(now)
        .bind(limit)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as(
            "SELECT * FROM messages WHERE channel_id = ?
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(&channel_id)
        .bind(now)
        .bind(limit)
        .fetch_all(&state.db)
        .await
    }
    .map_err(crate::api::error::internal)?;

    // N+1 (author + reactions + reply preview per message) — acceptable on
    // in-process SQLite at limit≤100; batch with JOINs if profiling shows contention.
    let mut out = Vec::with_capacity(messages.len());
    for msg in messages {
        let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
            .bind(&msg.author_id)
            .fetch_one(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

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
            embeds: parse_attachments(&msg.embeds),
            reactions,
            reply_to,
            poll,
            expires_at: msg.expires_at,
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
    /// Signed `/files/<id>?s=<sig>` path, persisted into the `attachments` JSON so the
    /// client can load the file directly (and so the URL validates under
    /// `OHIYO_REQUIRE_SIGNED_FILES`) without rebuilding it from the bare id.
    url: String,
}

/// Row shape for an attachment-metadata lookup:
/// `(filename, content_type, size_bytes, width, height)`.
type AttachmentRow = (String, String, i64, Option<i64>, Option<i64>);

/// Parse a stored JSON string column (attachments or embeds) into an array value.
fn parse_attachments(raw: &Option<String>) -> Option<serde_json::Value> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// Fetch link-preview embeds for a just-written message off the request path, then
/// persist them and broadcast a `MessageUpdate` so clients fill the card in. No-op
/// unless `EMBEDS_ENABLED` is set; failures are logged, never surfaced to the user.
fn spawn_embed_refresh(
    state: &AppState,
    id: String,
    channel_id: String,
    content: String,
    viewer: String,
) {
    if !crate::api::embeds::embeds_enabled() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let Some(embeds_json) = crate::api::embeds::build_embeds(&content).await else {
            return;
        };
        // Guard on content: if the message was edited (content changed) or deleted
        // while we were fetching, rows_affected == 0 and we drop these now-stale
        // embeds instead of clobbering the newer state.
        match sqlx::query("UPDATE messages SET embeds = ? WHERE id = ? AND content = ?")
            .bind(&embeds_json)
            .bind(&id)
            .bind(&content)
            .execute(&state.db)
            .await
        {
            Ok(r) if r.rows_affected() == 0 => return,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("embed persist failed for {id}: {e}");
                return;
            }
        }
        let reloaded: Result<Message, _> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await;
        match reloaded {
            Ok(m) => {
                if let Ok(full) = build_full(&state, m, &viewer).await {
                    broadcast_to_channel(&state, &channel_id, &GatewayEvent::MessageUpdate(full))
                        .await;
                }
            }
            Err(e) => tracing::warn!("embed reload failed for {id}: {e}"),
        }
    });
}

/// Enqueue a Meilisearch index update for a message (fire-and-forget). Resolves the
/// channel's server (None for DMs) so search can be scoped per server. No-op unless
/// MEILISEARCH_ENABLED.
fn spawn_index(
    state: &AppState,
    id: String,
    channel_id: String,
    author_id: String,
    author_name: String,
    content: String,
    created_at: i64,
) {
    if !crate::search::search_enabled() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        // NULL server_id (DM channel) decodes as Some("") on this stack — double-flatten.
        let server_id: Option<String> =
            sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
                .bind(&channel_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .flatten();
        crate::search::index_message(crate::search::MessageDoc {
            id,
            channel_id,
            server_id,
            author_id,
            author_name,
            content,
            created_at,
        })
        .await;
    });
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
    let dm_peers: Vec<String> = sqlx::query_scalar(
        "SELECT dp.user_id FROM dm_participants dp
         JOIN channels c ON c.id = dp.channel_id
         WHERE dp.channel_id = ? AND c.server_id IS NULL AND dp.user_id != ?",
    )
    .bind(&channel_id)
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for peer in dm_peers {
        if crate::api::abuse::is_blocked_pair(&state, &auth.0, &peer).await {
            return Err((StatusCode::FORBIDDEN, "you can't message this user".into()));
        }
    }
    // Refresh liveness so an active user never trips their dead-man's switch.
    crate::api::users::touch_active(&state.db, &auth.0).await;
    // Per-user spam throttle (generous for humans, blocks flooders).
    if !state
        .rate
        .check(&format!("msg:{}", auth.0), 30, Duration::from_secs(10))
    {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're sending messages too fast".into(),
        ));
    }
    if body.content.len() > 4000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "message too long (max 4000 chars)".into(),
        ));
    }
    if body.content.trim().is_empty() && body.attachment_ids.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "content or attachments required".into(),
        ));
    }

    let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&auth.0)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    // Look up attachment metadata and build JSON.
    let attachments_json = if body.attachment_ids.is_empty() {
        None
    } else {
        let mut metas: Vec<AttachmentMeta> = Vec::new();
        for file_id in &body.attachment_ids {
            let row: Option<AttachmentRow> = sqlx::query_as(
                "SELECT filename, content_type, size_bytes, width, height FROM files WHERE id = ?",
            )
            .bind(file_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

            if let Some((filename, content_type, size_bytes, width, height)) = row {
                metas.push(AttachmentMeta {
                    url: crate::signed_file_path(file_id),
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

    // Disappearing messages: if the channel has a TTL, this message self-destructs.
    let disappearing: Option<i64> =
        sqlx::query_scalar("SELECT disappearing_seconds FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    let expires_at = disappearing.filter(|s| *s > 0).map(|s| now + s);

    // Only honour a reply target that actually exists in this channel.
    let reply_to: Option<String> = match body.reply_to.filter(|s| !s.is_empty()) {
        Some(rid) => {
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT id FROM messages WHERE id = ? AND channel_id = ?")
                    .bind(&rid)
                    .bind(&channel_id)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(crate::api::error::internal)?;
            exists.map(|_| rid)
        }
        None => None,
    };

    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, attachments, reply_to, expires_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&channel_id)
    .bind(&auth.0)
    .bind(&content)
    .bind(now)
    .bind(&attachments_json)
    .bind(&reply_to)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

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
        embeds: None,
        expires_at,
    };

    broadcast_to_channel(
        &state,
        &msg.channel_id,
        &GatewayEvent::MessageCreate(msg.clone()),
    )
    .await;
    // Resolve link-preview embeds off the hot path; a MessageUpdate follows when ready.
    spawn_embed_refresh(
        &state,
        msg.id.clone(),
        msg.channel_id.clone(),
        msg.content.clone(),
        auth.0.clone(),
    );
    spawn_index(
        &state,
        msg.id.clone(),
        msg.channel_id.clone(),
        msg.author.id.clone(),
        msg.author.display_name.clone(),
        msg.content.clone(),
        msg.created_at,
    );
    // Content-free push relay: queue a wake-up nudge for offline recipients only.
    // The relay stores no message text/channel names/E2E keys; online users already got
    // the GatewayEvent above.
    crate::api::push::enqueue_message_pushes(&state, &msg.channel_id, &auth.0).await;
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
        .map_err(crate::api::error::internal)?;
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
        embeds: parse_attachments(&msg.embeds),
        reactions,
        reply_to,
        poll,
        expires_at: msg.expires_at,
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
        Some(sid) => {
            sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
                .bind(sid)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
        }
        None => {
            sqlx::query_as("SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ?")
                .bind(channel_id)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
        }
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
    .map_err(crate::api::error::internal)?;

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
        return Err((
            StatusCode::BAD_REQUEST,
            "message too long (max 4000 chars)".into(),
        ));
    }

    let msg: Option<Message> =
        sqlx::query_as("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
            .bind(&id)
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    if msg.author_id != auth.0 {
        return Err((StatusCode::FORBIDDEN, "not your message".into()));
    }

    let now = now_unix();
    // Clear any stale embeds synchronously; the async refresh re-adds them for the new content.
    sqlx::query("UPDATE messages SET content = ?, edited_at = ?, embeds = NULL WHERE id = ?")
        .bind(&content)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let updated = Message {
        content,
        edited_at: Some(now),
        embeds: None,
        ..msg
    };
    let full = build_full(&state, updated, &auth.0).await?;
    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::MessageUpdate(full.clone()),
    )
    .await;
    spawn_embed_refresh(
        &state,
        full.id.clone(),
        full.channel_id.clone(),
        full.content.clone(),
        auth.0.clone(),
    );
    spawn_index(
        &state,
        full.id.clone(),
        full.channel_id.clone(),
        full.author.id.clone(),
        full.author.display_name.clone(),
        full.content.clone(),
        full.created_at,
    );
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
            .map_err(crate::api::error::internal)?;
    if let Some((Some(sid),)) = chan {
        if !crate::api::roles::has_perm(
            state,
            &sid,
            user_id,
            crate::api::roles::perm::MANAGE_MESSAGES,
        )
        .await
        {
            return Err((
                StatusCode::FORBIDDEN,
                "you need Manage Messages to pin".into(),
            ));
        }
    }
    let msg: Option<Message> =
        sqlx::query_as("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
            .bind(id)
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    let flag = if pinned { 1 } else { 0 };
    sqlx::query("UPDATE messages SET pinned = ? WHERE id = ?")
        .bind(flag)
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let updated = Message {
        pinned: flag,
        ..msg
    };
    let full = build_full(state, updated, user_id).await?;
    broadcast_to_channel(
        state,
        channel_id,
        &GatewayEvent::MessageUpdate(full.clone()),
    )
    .await;
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
            .map_err(crate::api::error::internal)?;
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
    .map_err(crate::api::error::internal)?;

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
    .map_err(crate::api::error::internal)?;

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
            .map_err(crate::api::error::internal)?;

    let msg = msg.ok_or((StatusCode::NOT_FOUND, "message not found".into()))?;

    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let server_id = row.and_then(|(s,)| s);
    if msg.author_id != auth.0 {
        // Mods with MANAGE_MESSAGES can delete others' messages in a server channel.
        let can = match server_id.as_deref() {
            Some(sid) => {
                crate::api::roles::has_perm(
                    &state,
                    sid,
                    &auth.0,
                    crate::api::roles::perm::MANAGE_MESSAGES,
                )
                .await
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
        .map_err(crate::api::error::internal)?;

    if crate::search::search_enabled() {
        tokio::spawn(crate::search::delete_message(id.clone()));
    }
    if msg.author_id != auth.0 {
        let metadata = format!("author_id={}", msg.author_id);
        crate::api::abuse::log_action(
            &state,
            crate::api::abuse::ActionLog {
                server_id: server_id.as_deref(),
                actor_id: &auth.0,
                action: "delete_message",
                target_type: "message",
                target_id: &id,
                report_id: None,
                metadata: Some(&metadata),
            },
        )
        .await?;
    }

    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::MessageDelete {
            id,
            channel_id: channel_id.clone(),
        },
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DisappearingBody {
    /// TTL in seconds; 0 or null turns disappearing messages off.
    pub seconds: Option<i64>,
}

/// PATCH /channels/{id}/disappearing — set (or clear) the channel's message TTL.
/// Allowed for any DM participant, or MANAGE_CHANNELS on a server channel.
pub async fn set_disappearing(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<DisappearingBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    // On a server channel, require MANAGE_CHANNELS; DMs are open to participants.
    let server_id: Option<String> =
        sqlx::query_scalar("SELECT server_id FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    if let Some(sid) = server_id {
        if !crate::api::roles::has_perm(
            &state,
            &sid,
            &auth.0,
            crate::api::roles::perm::MANAGE_CHANNELS,
        )
        .await
        {
            return Err((StatusCode::FORBIDDEN, "need Manage Channels".into()));
        }
    }
    // Clamp to a sane range (max 7 days); 0/None/negative disables.
    let secs = body.seconds.filter(|s| *s > 0).map(|s| s.min(7 * 86_400));
    sqlx::query("UPDATE channels SET disappearing_seconds = ? WHERE id = ?")
        .bind(secs)
        .bind(&channel_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::DisappearingUpdate {
            channel_id: channel_id.clone(),
            seconds: secs,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SenderKeyBody {
    /// recipient user_id → pairwise-encrypted SKDM envelope (only they can open it).
    pub envelopes: std::collections::HashMap<String, String>,
}

/// POST /channels/{id}/sender-key — relay a member's encrypted Sender Key Distribution
/// Messages to the group (group E2E bootstrap). The server only forwards opaque
/// ciphertext; it never sees the sender key.
pub async fn distribute_sender_key(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<SenderKeyBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    if body.envelopes.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "too many recipients".into()));
    }
    // Enforce the membership boundary server-side: a sender key may only be relayed to
    // users who are CURRENTLY in the channel. This is what makes a re-key effective —
    // a member removed at a higher epoch must never receive a fresh key, no matter what
    // recipient map a (buggy or malicious) client submits. Membership depends on the
    // channel kind: server channels draw from server_members, DMs from dm_participants.
    // (A NULL server_id decodes as Some("") on this stack — double-flatten to None.)
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    let members: std::collections::HashSet<String> = match server_id {
        Some(sid) => sqlx::query_scalar("SELECT user_id FROM server_members WHERE server_id = ?")
            .bind(sid)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default(),
        None => sqlx::query_scalar("SELECT user_id FROM dm_participants WHERE channel_id = ?")
            .bind(&channel_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default(),
    }
    .into_iter()
    .collect();
    for (uid, envelope) in body.envelopes {
        if envelope.len() > 20_000 || !members.contains(&uid) {
            continue;
        }
        crate::gateway::broadcast_to_user(
            &state.sessions,
            &uid,
            &GatewayEvent::SenderKeyDistribution {
                channel_id: channel_id.clone(),
                from_user_id: auth.0.clone(),
                envelope,
            },
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct VoiceKeyBody {
    /// recipient user_id → pairwise-encrypted voice-key envelope.
    pub envelopes: std::collections::HashMap<String, String>,
}

const VOICE_KEY_MAX_PER_MIN: usize = 120;

/// POST /channels/{id}/voice-key — relay encrypted voice/video E2EE room keys among the
/// people CURRENTLY in this voice call. Like the sender-key relay the server only ever
/// forwards opaque ciphertext. Crucially the recipient set is the live voice-room
/// roster (same rule as the WebRTC signal relay), NOT mere channel membership: a room
/// key must never reach someone who isn't in the call — not even another member of the
/// channel — so it can't leak to a lurking guild member.
pub async fn distribute_voice_key(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<VoiceKeyBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.envelopes.len() > 64 {
        return Err((StatusCode::BAD_REQUEST, "too many recipients".into()));
    }
    // Throttle gossip so a participant can't flood the call's sockets / the DB.
    if !state.rate.check(
        &format!("voice-key:{}", auth.0),
        VOICE_KEY_MAX_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    let in_room: std::collections::HashSet<String> = {
        let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
        match rooms.get(&channel_id) {
            Some(room) => room.keys().cloned().collect(),
            None => return Err((StatusCode::FORBIDDEN, "no active call here".into())),
        }
    };
    if !in_room.contains(&auth.0) {
        return Err((StatusCode::FORBIDDEN, "not in this call".into()));
    }
    for (uid, envelope) in body.envelopes {
        if envelope.len() > 20_000 || !in_room.contains(&uid) {
            continue;
        }
        crate::gateway::broadcast_to_user(
            &state.sessions,
            &uid,
            &GatewayEvent::VoiceKeyDistribution {
                channel_id: channel_id.clone(),
                from_user_id: auth.0.clone(),
                envelope,
            },
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Delete disappearing messages whose TTL has lapsed and tell connected clients.
/// Driven by a periodic task in `main`. Bounded per pass so a huge backlog can't
/// monopolize the connection (the next pass picks up the rest).
pub async fn sweep_expired(state: &AppState) {
    let now = now_unix();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, channel_id FROM messages
         WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return;
    }
    for (id, channel_id) in rows {
        if sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await
            .is_err()
        {
            continue;
        }
        if crate::search::search_enabled() {
            tokio::spawn(crate::search::delete_message(id.clone()));
        }
        broadcast_to_channel(
            state,
            &channel_id,
            &GatewayEvent::MessageDelete {
                id,
                channel_id: channel_id.clone(),
            },
        )
        .await;
    }
}
