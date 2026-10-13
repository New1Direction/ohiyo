//! A channel's (or a category's) own permissions: per @everyone, role or member, which
//! channel permissions are allowed, denied, or left to their roles. This is how a channel
//! becomes private: deny View channel to @everyone, allow it to the roles let in.
//!
//! Editing them needs Manage roles where they apply (Discord's "Manage permissions"). Only
//! the permissions that make sense on a channel can be set, never one the editor lacks, and
//! never on a role ranked at or above the editor's own.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::roles::{self, perm},
    auth::AuthUser,
    gateway::broadcast_to_server,
    types::{new_id, now_unix, GatewayEvent},
    AppState,
};

type ApiError = (StatusCode, String);

/// The permissions a channel or category can set for itself.
pub const CHANNEL_SCOPED: i64 = perm::VIEW_CHANNEL
    | perm::SEND_MESSAGES
    | perm::MANAGE_MESSAGES
    | perm::MANAGE_CHANNELS
    | perm::MANAGE_ROLES
    | perm::CREATE_INVITE;

#[derive(Serialize, sqlx::FromRow)]
pub struct OverwriteRow {
    pub target_type: String,
    pub target_id: Option<String>,
    #[sqlx(rename = "allow_permissions")]
    pub allow: i64,
    #[sqlx(rename = "deny_permissions")]
    pub deny: i64,
}

#[derive(Deserialize)]
pub struct OverwriteBody {
    #[serde(default)]
    pub allow: i64,
    #[serde(default)]
    pub deny: i64,
}

/// The editor's permissions where the overwrites apply; errors if the scope isn't this
/// space's channel or category.
async fn scope_permissions(
    state: &AppState,
    server_id: &str,
    scope_type: &str,
    scope_id: &str,
    user_id: &str,
) -> Result<i64, ApiError> {
    let not_found = || {
        (
            StatusCode::NOT_FOUND,
            "channel or category not found".to_string(),
        )
    };
    match scope_type {
        "channel" => {
            // A thread takes its parent channel's permissions, so it has none of its own.
            let row: Option<(Option<String>, Option<String>)> =
                sqlx::query_as("SELECT server_id, parent_id FROM channels WHERE id = ?")
                    .bind(scope_id)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(crate::api::error::internal)?;
            match row {
                Some((Some(sid), None)) if sid == server_id => {}
                _ => return Err(not_found()),
            }
            Ok(roles::channel_permissions(state, scope_id, user_id).await)
        }
        "category" => {
            let exists: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM categories WHERE id = ? AND server_id = ?")
                    .bind(scope_id)
                    .bind(server_id)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(crate::api::error::internal)?;
            if exists.is_none() {
                return Err(not_found());
            }
            let mine = roles::member_permissions(state, server_id, user_id).await;
            Ok(if mine & perm::ADMINISTRATOR != 0 {
                perm::ALL
            } else {
                mine
            })
        }
        _ => Err(not_found()),
    }
}

async fn require_manage(
    state: &AppState,
    server_id: &str,
    scope_type: &str,
    scope_id: &str,
    user_id: &str,
) -> Result<i64, ApiError> {
    let mine = scope_permissions(state, server_id, scope_type, scope_id, user_id).await?;
    if mine & perm::MANAGE_ROLES == 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't change permissions here".into(),
        ));
    }
    Ok(mine)
}

async fn announce(state: &AppState, server_id: &str) {
    crate::api::servers::broadcast_full_server_to_members(state, server_id).await;
    broadcast_to_server(
        state,
        server_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.to_owned(),
        },
    )
    .await;
}

/// GET /servers/{server_id}/permission-overwrites/{scope_type}/{scope_id}
pub async fn list_overwrites(
    auth: AuthUser,
    Path((server_id, scope_type, scope_id)): Path<(String, String, String)>,
    State(state): State<AppState>,
) -> Result<Json<Vec<OverwriteRow>>, ApiError> {
    let mine = scope_permissions(&state, &server_id, &scope_type, &scope_id, &auth.0).await?;
    if mine & (perm::MANAGE_ROLES | perm::MANAGE_CHANNELS) == 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't see these permissions".into(),
        ));
    }
    let rows: Vec<OverwriteRow> = sqlx::query_as(
        "SELECT target_type, target_id, allow_permissions, deny_permissions
         FROM permission_overwrites
         WHERE scope_type = ? AND scope_id = ? AND target_type != 'unknown'
         ORDER BY CASE target_type WHEN 'everyone' THEN 0 WHEN 'role' THEN 1 ELSE 2 END, created_at",
    )
    .bind(&scope_type)
    .bind(&scope_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

/// PUT /servers/{server_id}/permission-overwrites/{scope_type}/{scope_id}/{target_type}/{target_id}
/// — set what one @everyone / role / member may do here. `target_id` is `everyone` for
/// @everyone. Allow and deny both empty means "leave it to their roles".
pub async fn set_overwrite(
    auth: AuthUser,
    Path((server_id, scope_type, scope_id, target_type, target_id)): Path<(
        String,
        String,
        String,
        String,
        String,
    )>,
    State(state): State<AppState>,
    Json(body): Json<OverwriteBody>,
) -> Result<StatusCode, ApiError> {
    let mine = require_manage(&state, &server_id, &scope_type, &scope_id, &auth.0).await?;
    let target = check_target(&state, &server_id, &target_type, &target_id, &auth.0).await?;
    let (allow, deny) = (body.allow, body.deny);
    if (allow | deny) & !CHANNEL_SCOPED != 0 || allow < 0 || deny < 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "only channel permissions can be set on a channel".into(),
        ));
    }
    if allow & deny != 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "a permission can't be both allowed and denied".into(),
        ));
    }
    // Like Discord: whatever changes, added or lifted, has to be the editor's own to give.
    let (old_allow, old_deny) =
        current_bits(&state, &scope_type, &scope_id, &target_type, &target).await?;
    if ((allow ^ old_allow) | (deny ^ old_deny)) & !mine != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't set permissions you don't have".into(),
        ));
    }
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    sqlx::query(
        "DELETE FROM permission_overwrites
         WHERE scope_type = ? AND scope_id = ? AND target_type = ? AND target_id IS ?",
    )
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(&target_type)
    .bind(&target)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    if allow | deny != 0 {
        sqlx::query(
            "INSERT INTO permission_overwrites
             (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
             VALUES (?,?,?,?,?,?,?,?, 'ohiyo', ?)",
        )
        .bind(new_id())
        .bind(&server_id)
        .bind(&scope_type)
        .bind(&scope_id)
        .bind(&target_type)
        .bind(&target)
        .bind(allow)
        .bind(deny)
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    }
    tx.commit().await.map_err(crate::api::error::internal)?;
    log(
        &state,
        &server_id,
        &auth.0,
        "set_channel_permissions",
        &scope_type,
        &scope_id,
    )
    .await?;
    announce(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE …/{target_type}/{target_id} — leave everything to their roles again.
pub async fn delete_overwrite(
    auth: AuthUser,
    Path((server_id, scope_type, scope_id, target_type, target_id)): Path<(
        String,
        String,
        String,
        String,
        String,
    )>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    let mine = require_manage(&state, &server_id, &scope_type, &scope_id, &auth.0).await?;
    let target = check_target(&state, &server_id, &target_type, &target_id, &auth.0).await?;
    let (old_allow, old_deny) =
        current_bits(&state, &scope_type, &scope_id, &target_type, &target).await?;
    if (old_allow | old_deny) & !mine != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't lift permissions you don't have".into(),
        ));
    }
    sqlx::query(
        "DELETE FROM permission_overwrites
         WHERE scope_type = ? AND scope_id = ? AND target_type = ? AND target_id IS ?",
    )
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(&target_type)
    .bind(&target)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    log(
        &state,
        &server_id,
        &auth.0,
        "set_channel_permissions",
        &scope_type,
        &scope_id,
    )
    .await?;
    announce(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/{server_id}/permission-overwrites/{scope_type}/{scope_id} — drop all of a
/// channel's own permissions so it follows its category again ("Sync with category").
pub async fn clear_overwrites(
    auth: AuthUser,
    Path((server_id, scope_type, scope_id)): Path<(String, String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    let mine = require_manage(&state, &server_id, &scope_type, &scope_id, &auth.0).await?;
    // Clearing can lift a deny the editor couldn't have set; only someone who holds every
    // channel permission may wipe the slate.
    if CHANNEL_SCOPED & !mine != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't reset permissions you don't all have".into(),
        ));
    }
    sqlx::query("DELETE FROM permission_overwrites WHERE scope_type = ? AND scope_id = ?")
        .bind(&scope_type)
        .bind(&scope_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    log(
        &state,
        &server_id,
        &auth.0,
        "sync_channel_permissions",
        &scope_type,
        &scope_id,
    )
    .await?;
    announce(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// What one target is allowed and denied at a scope now (nothing set: both 0).
async fn current_bits(
    state: &AppState,
    scope_type: &str,
    scope_id: &str,
    target_type: &str,
    target: &Option<String>,
) -> Result<(i64, i64), ApiError> {
    // An imported space can hold more than one row per target; together they apply.
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT allow_permissions, deny_permissions FROM permission_overwrites
         WHERE scope_type = ? AND scope_id = ? AND target_type = ? AND target_id IS ?",
    )
    .bind(scope_type)
    .bind(scope_id)
    .bind(target_type)
    .bind(target)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(rows
        .into_iter()
        .fold((0, 0), |(allow, deny), (a, d)| (allow | a, deny | d)))
}

/// The stored target id for a path target (None for @everyone), after checking it belongs
/// to this space and, for a role, ranks below the editor.
async fn check_target(
    state: &AppState,
    server_id: &str,
    target_type: &str,
    target_id: &str,
    actor_id: &str,
) -> Result<Option<String>, ApiError> {
    match target_type {
        "everyone" if target_id == "everyone" => Ok(None),
        "role" => {
            let role: Option<(i64, bool)> = sqlx::query_as(
                "SELECT position, is_everyone FROM roles WHERE id = ? AND server_id = ?",
            )
            .bind(target_id)
            .bind(server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
            let Some((position, is_everyone)) = role else {
                return Err((StatusCode::NOT_FOUND, "role not found".into()));
            };
            if is_everyone {
                return Err((StatusCode::BAD_REQUEST, "use everyone for @everyone".into()));
            }
            if position >= roles::member_top_position(state, server_id, actor_id).await {
                return Err((
                    StatusCode::FORBIDDEN,
                    "you can't change a role ranked at or above your own".into(),
                ));
            }
            Ok(Some(target_id.to_owned()))
        }
        "member" => {
            if !crate::api::servers::is_member(state, server_id, target_id).await {
                return Err((
                    StatusCode::NOT_FOUND,
                    "that person isn't in this space".into(),
                ));
            }
            Ok(Some(target_id.to_owned()))
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            "target is everyone, a role or a member".into(),
        )),
    }
}

async fn log(
    state: &AppState,
    server_id: &str,
    actor_id: &str,
    action: &str,
    scope_type: &str,
    scope_id: &str,
) -> Result<(), ApiError> {
    crate::api::abuse::log_action(
        state,
        crate::api::abuse::ActionLog {
            server_id: Some(server_id),
            actor_id,
            action,
            target_type: scope_type,
            target_id: scope_id,
            report_id: None,
            metadata: None,
        },
    )
    .await
}
