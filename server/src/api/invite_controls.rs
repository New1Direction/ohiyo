//! Who may make invite links, pausing a space's invites, and the list of its links.

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
    types::{now_unix, GatewayEvent},
    AppState,
};

type ApiError = (StatusCode, String);

/// Whether `user_id` may make invite links in `server_id`.
pub async fn can_create_invites(state: &AppState, server_id: &str, user_id: &str) -> bool {
    roles::member_permissions(state, server_id, user_id).await
        & (perm::CREATE_INVITE | perm::MANAGE_SERVER | perm::ADMINISTRATOR)
        != 0
}

/// Whether `user_id` runs the space's invites (sees and revokes everyone's, pauses them).
pub async fn manages_invites(state: &AppState, server_id: &str, user_id: &str) -> bool {
    roles::member_permissions(state, server_id, user_id).await
        & (perm::MANAGE_SERVER | perm::ADMINISTRATOR)
        != 0
}

/// Whether the space's invites are paused.
pub async fn invites_paused(state: &AppState, server_id: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT invites_paused FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

#[derive(Serialize)]
pub struct InviteSettings {
    pub paused: bool,
    pub members_can_invite: bool,
}

#[derive(Deserialize, Default)]
pub struct InviteSettingsPatch {
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default)]
    pub members_can_invite: Option<bool>,
}

async fn invite_settings(state: &AppState, server_id: &str) -> InviteSettings {
    InviteSettings {
        paused: invites_paused(state, server_id).await,
        members_can_invite: roles::everyone_permissions_of(state, server_id).await
            & perm::CREATE_INVITE
            != 0,
    }
}

async fn require_invite_manager(
    state: &AppState,
    server_id: &str,
    user_id: &str,
) -> Result<(), ApiError> {
    if manages_invites(state, server_id, user_id).await {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "only people who manage the space can do that".into(),
        ))
    }
}

/// GET /servers/{server_id}/invite-settings
pub async fn get_invite_settings(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<InviteSettings>, ApiError> {
    require_invite_manager(&state, &server_id, &auth.0).await?;
    Ok(Json(invite_settings(&state, &server_id).await))
}

/// A moderation log line for a change to how a space takes new members.
fn invite_log<'a>(
    server_id: &'a str,
    actor_id: &'a str,
    action: &'a str,
) -> crate::api::abuse::ActionLog<'a> {
    crate::api::abuse::ActionLog {
        server_id: Some(server_id),
        actor_id,
        action,
        target_type: "server",
        target_id: server_id,
        report_id: None,
        metadata: None,
    }
}

/// PATCH /servers/{server_id}/invite-settings — pause invites, or decide whether members
/// may make them.
pub async fn update_invite_settings(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(patch): Json<InviteSettingsPatch>,
) -> Result<Json<InviteSettings>, ApiError> {
    require_invite_manager(&state, &server_id, &auth.0).await?;
    if let Some(paused) = patch.paused {
        if paused != invites_paused(&state, &server_id).await {
            sqlx::query("UPDATE servers SET invites_paused = ? WHERE id = ?")
                .bind(paused)
                .bind(&server_id)
                .execute(&state.db)
                .await
                .map_err(crate::api::error::internal)?;
            crate::api::abuse::log_action(
                &state,
                invite_log(
                    &server_id,
                    &auth.0,
                    if paused {
                        "pause_invites"
                    } else {
                        "resume_invites"
                    },
                ),
            )
            .await?;
        }
    }
    if let Some(allowed) = patch.members_can_invite {
        let current = roles::everyone_permissions_of(&state, &server_id).await;
        if (current & perm::CREATE_INVITE != 0) != allowed {
            set_everyone_permission(&state, &server_id, perm::CREATE_INVITE, allowed).await?;
            crate::api::abuse::log_action(
                &state,
                invite_log(
                    &server_id,
                    &auth.0,
                    if allowed {
                        "members_invite_on"
                    } else {
                        "members_invite_off"
                    },
                ),
            )
            .await?;
            broadcast_to_server(
                &state,
                &server_id,
                &GatewayEvent::PermissionsUpdate {
                    server_id: server_id.clone(),
                },
            )
            .await;
        }
    }
    Ok(Json(invite_settings(&state, &server_id).await))
}

/// Turn one permission on or off for @everyone, giving the space an @everyone role (with
/// the default permissions) if it has none yet.
async fn set_everyone_permission(
    state: &AppState,
    server_id: &str,
    flag: i64,
    on: bool,
) -> Result<(), ApiError> {
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(crate::api::error::internal)?;
    let role: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, permissions FROM roles WHERE server_id = ? AND is_everyone = 1 ORDER BY created_at LIMIT 1",
    )
    .bind(server_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    let (id, permissions) = match role {
        Some(row) => row,
        None => {
            let id = crate::types::new_id();
            sqlx::query(
                "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at, is_everyone)
                 VALUES (?, ?, '@everyone', NULL, ?, 0, ?, 1)",
            )
            .bind(&id)
            .bind(server_id)
            .bind(perm::DEFAULT_MEMBER)
            .bind(now_unix())
            .execute(&mut *tx)
            .await
            .map_err(crate::api::error::internal)?;
            (id, perm::DEFAULT_MEMBER)
        }
    };
    let permissions = if on {
        permissions | flag
    } else {
        permissions & !flag
    };
    sqlx::query("UPDATE roles SET permissions = ? WHERE id = ?")
        .bind(permissions)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    tx.commit().await.map_err(crate::api::error::internal)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InviteRow {
    pub code: String,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub uses: i64,
    pub max_uses: Option<i64>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

/// GET /servers/{server_id}/invites — the space's invite links: every one for the people
/// who manage the space, your own for everyone else.
pub async fn list_invites(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<InviteRow>>, ApiError> {
    if !crate::api::servers::is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let everyone = manages_invites(&state, &server_id, &auth.0).await;
    let rows: Vec<InviteRow> = sqlx::query_as(
        "SELECT i.code, i.created_by, u.display_name AS created_by_name, i.uses, i.max_uses,
                i.expires_at, i.created_at
         FROM invites i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.server_id = ? AND (? OR i.created_by = ?)
         ORDER BY i.created_at DESC LIMIT 200",
    )
    .bind(&server_id)
    .bind(everyone)
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}
