//! Minimal abuse/report/block safety layer.
//!
//! Reports intentionally store moderation metadata, not message plaintext. E2E content
//! may be ciphertext; reviewers use ids/context they are allowed to access.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{auth::AuthUser, types::now_unix, AppState};

const REPORT_MAX_PER_HOUR: usize = 20;
const BLOCK_MAX_PER_MIN: usize = 60;

#[derive(Serialize, sqlx::FromRow)]
pub struct BlockedUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AbuseReport {
    pub id: String,
    pub reporter_id: String,
    pub target_type: String,
    pub target_id: String,
    pub server_id: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub accused_user_id: Option<String>,
    pub reason: String,
    pub details: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub resolved_by: Option<String>,
    pub resolved_at: Option<i64>,
    pub resolution_note: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ModerationAction {
    pub id: String,
    pub server_id: Option<String>,
    pub actor_id: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub report_id: Option<String>,
    pub metadata: Option<String>,
    pub created_at: i64,
}

#[derive(Deserialize)]
pub struct CreateReportBody {
    pub target_type: String,
    pub target_id: String,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub details: Option<String>,
}

#[derive(Deserialize)]
pub struct ResolveReportBody {
    pub status: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct HideMessageBody {
    #[serde(default)]
    pub hidden: Option<bool>,
}

pub async fn is_blocked_pair(state: &AppState, a: &str, b: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)",
    )
    .bind(a)
    .bind(b)
    .bind(b)
    .bind(a)
    .fetch_one(&state.db)
    .await
    .map(|n| n > 0)
    .unwrap_or(false)
}

pub async fn list_blocks(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<BlockedUser>>, (StatusCode, String)> {
    let rows: Vec<BlockedUser> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.avatar_url, ub.created_at
         FROM user_blocks ub JOIN users u ON u.id = ub.blocked_id
         WHERE ub.blocker_id = ?
         ORDER BY ub.created_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

pub async fn block_user(
    auth: AuthUser,
    Path(user_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !state.rate.check(
        &format!("block:{}", auth.0),
        BLOCK_MAX_PER_MIN,
        std::time::Duration::from_secs(60),
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    if user_id == auth.0 {
        return Err((StatusCode::BAD_REQUEST, "you can't block yourself".into()));
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = ?")
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "user not found".into()));
    }
    sqlx::query(
        "INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)",
    )
    .bind(&auth.0)
    .bind(&user_id)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    log_action(
        &state,
        ActionLog {
            server_id: None,
            actor_id: &auth.0,
            action: "block_user",
            target_type: "user",
            target_id: &user_id,
            report_id: None,
            metadata: None,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unblock_user(
    auth: AuthUser,
    Path(user_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?")
        .bind(&auth.0)
        .bind(&user_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    log_action(
        &state,
        ActionLog {
            server_id: None,
            actor_id: &auth.0,
            action: "unblock_user",
            target_type: "user",
            target_id: &user_id,
            report_id: None,
            metadata: None,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn hide_message(
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<HideMessageBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    if body.hidden == Some(false) {
        sqlx::query("DELETE FROM hidden_messages WHERE user_id = ? AND message_id = ?")
            .bind(&auth.0)
            .bind(&message_id)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    } else {
        sqlx::query(
            "INSERT OR IGNORE INTO hidden_messages (user_id, channel_id, message_id, hidden_at)
             VALUES (?,?,?,?)",
        )
        .bind(&auth.0)
        .bind(&channel_id)
        .bind(&message_id)
        .bind(now_unix())
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_hidden_messages(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT message_id FROM hidden_messages WHERE user_id = ? AND channel_id = ? ORDER BY hidden_at DESC",
    )
    .bind(&auth.0)
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

pub async fn create_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateReportBody>,
) -> Result<Json<AbuseReport>, (StatusCode, String)> {
    if !state.rate.check(
        &format!("report:{}", auth.0),
        REPORT_MAX_PER_HOUR,
        std::time::Duration::from_secs(3600),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're reporting too fast".into(),
        ));
    }
    let target_type = body.target_type.trim().to_ascii_lowercase();
    if !matches!(target_type.as_str(), "message" | "user" | "server") {
        return Err((
            StatusCode::BAD_REQUEST,
            "target_type must be message, user, or server".into(),
        ));
    }
    let reason = body.reason.trim().chars().take(80).collect::<String>();
    if reason.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "reason required".into()));
    }
    let details = body
        .details
        .map(|d| d.trim().chars().take(2000).collect::<String>())
        .filter(|d| !d.is_empty());

    let (server_id, channel_id, message_id, accused_user_id) = resolve_target(
        &state,
        &auth.0,
        &target_type,
        &body.target_id,
        body.server_id.as_deref(),
    )
    .await?;
    let id = crate::types::new_id();
    sqlx::query(
        "INSERT INTO abuse_reports
         (id, reporter_id, target_type, target_id, server_id, channel_id, message_id, accused_user_id, reason, details, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?)",
    )
    .bind(&id)
    .bind(&auth.0)
    .bind(&target_type)
    .bind(&body.target_id)
    .bind(&server_id)
    .bind(&channel_id)
    .bind(&message_id)
    .bind(&accused_user_id)
    .bind(&reason)
    .bind(&details)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    log_action(
        &state,
        ActionLog {
            server_id: server_id.as_deref(),
            actor_id: &auth.0,
            action: "create_report",
            target_type: &target_type,
            target_id: &body.target_id,
            report_id: Some(&id),
            metadata: None,
        },
    )
    .await?;
    let report = load_report(&state, &id).await?;
    Ok(Json(report))
}

async fn resolve_target(
    state: &AppState,
    reporter_id: &str,
    target_type: &str,
    target_id: &str,
    context_server_id: Option<&str>,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    (StatusCode, String),
> {
    match target_type {
        "message" => {
            let row: Option<(String, String, Option<String>)> = sqlx::query_as(
                "SELECT m.channel_id, m.author_id, c.server_id
                 FROM messages m JOIN channels c ON c.id = m.channel_id
                 WHERE m.id = ?",
            )
            .bind(target_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
            let Some((channel_id, author_id, server_id)) = row else {
                return Err((StatusCode::NOT_FOUND, "message not found".into()));
            };
            if !crate::api::messages::user_can_access(state, &channel_id, reporter_id).await {
                return Err((StatusCode::FORBIDDEN, "no access to this message".into()));
            }
            Ok((
                server_id,
                Some(channel_id),
                Some(target_id.to_owned()),
                Some(author_id),
            ))
        }
        "user" => {
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = ?")
                .bind(target_id)
                .fetch_optional(&state.db)
                .await
                .map_err(crate::api::error::internal)?;
            if exists.is_none() {
                return Err((StatusCode::NOT_FOUND, "user not found".into()));
            }
            if let Some(server_id) = context_server_id {
                if !crate::api::servers::is_member(state, server_id, reporter_id).await
                    || !crate::api::servers::is_member(state, server_id, target_id).await
                {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "not a shared member of this server".into(),
                    ));
                }
                return Ok((
                    Some(server_id.to_owned()),
                    None,
                    None,
                    Some(target_id.to_owned()),
                ));
            }
            Ok((None, None, None, Some(target_id.to_owned())))
        }
        "server" => {
            if !crate::api::servers::is_member(state, target_id, reporter_id).await {
                return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
            }
            Ok((Some(target_id.to_owned()), None, None, None))
        }
        _ => unreachable!(),
    }
}

async fn load_report(state: &AppState, id: &str) -> Result<AbuseReport, (StatusCode, String)> {
    sqlx::query_as("SELECT * FROM abuse_reports WHERE id = ?")
        .bind(id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)
}

async fn can_view_queue(state: &AppState, server_id: &str, user_id: &str) -> bool {
    crate::api::roles::has_perm(
        state,
        server_id,
        user_id,
        crate::api::roles::perm::MANAGE_MESSAGES,
    )
    .await
        || crate::api::roles::has_perm(
            state,
            server_id,
            user_id,
            crate::api::roles::perm::BAN_MEMBERS,
        )
        .await
        || crate::api::roles::has_perm(
            state,
            server_id,
            user_id,
            crate::api::roles::perm::MANAGE_SERVER,
        )
        .await
}

pub async fn mod_queue(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<AbuseReport>>, (StatusCode, String)> {
    if !can_view_queue(&state, &server_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't view the moderation queue".into(),
        ));
    }
    let rows: Vec<AbuseReport> = sqlx::query_as(
        "SELECT * FROM abuse_reports
         WHERE server_id = ? AND status = 'open'
         ORDER BY created_at DESC LIMIT 200",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

pub async fn resolve_report(
    auth: AuthUser,
    Path((server_id, report_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<ResolveReportBody>,
) -> Result<Json<AbuseReport>, (StatusCode, String)> {
    if !can_view_queue(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "you can't resolve reports".into()));
    }
    let status = body.status.trim().to_ascii_lowercase();
    if !matches!(status.as_str(), "resolved" | "dismissed") {
        return Err((
            StatusCode::BAD_REQUEST,
            "status must be resolved or dismissed".into(),
        ));
    }
    let note = body
        .note
        .map(|n| n.trim().chars().take(1000).collect::<String>())
        .filter(|n| !n.is_empty());
    let changed = sqlx::query(
        "UPDATE abuse_reports
         SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?
         WHERE id = ? AND server_id = ?",
    )
    .bind(&status)
    .bind(&auth.0)
    .bind(now_unix())
    .bind(&note)
    .bind(&report_id)
    .bind(&server_id)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    if changed.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "report not found".into()));
    }
    let action = format!("report_{status}");
    log_action(
        &state,
        ActionLog {
            server_id: Some(&server_id),
            actor_id: &auth.0,
            action: &action,
            target_type: "report",
            target_id: &report_id,
            report_id: Some(&report_id),
            metadata: note.as_deref(),
        },
    )
    .await?;
    Ok(Json(load_report(&state, &report_id).await?))
}

pub async fn moderation_actions(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<ModerationAction>>, (StatusCode, String)> {
    if !can_view_queue(&state, &server_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't view moderation actions".into(),
        ));
    }
    let rows: Vec<ModerationAction> = sqlx::query_as(
        "SELECT * FROM moderation_actions WHERE server_id = ? ORDER BY created_at DESC LIMIT 200",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

pub struct ActionLog<'a> {
    pub server_id: Option<&'a str>,
    pub actor_id: &'a str,
    pub action: &'a str,
    pub target_type: &'a str,
    pub target_id: &'a str,
    pub report_id: Option<&'a str>,
    pub metadata: Option<&'a str>,
}

pub async fn log_action(
    state: &AppState,
    entry: ActionLog<'_>,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        "INSERT INTO moderation_actions (id, server_id, actor_id, action, target_type, target_id, report_id, metadata, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(crate::types::new_id())
    .bind(entry.server_id)
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(entry.report_id)
    .bind(entry.metadata)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(())
}
