use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    gateway::{broadcast_to_server, broadcast_to_user},
    types::{new_id, now_unix, GatewayEvent, Role},
    AppState,
};

// ── Permission flags (bitfield) ───────────────────────────────────────────────
pub mod perm {
    pub const MANAGE_CHANNELS: i64 = 1 << 0;
    pub const MANAGE_MESSAGES: i64 = 1 << 1; // delete others' messages, manage pins
    pub const KICK_MEMBERS: i64 = 1 << 2;
    pub const BAN_MEMBERS: i64 = 1 << 3;
    pub const MANAGE_ROLES: i64 = 1 << 4;
    #[allow(dead_code)] // reserved: rename/settings (gated client-side today)
    pub const MANAGE_SERVER: i64 = 1 << 5;
    pub const ALL: i64 = (1 << 6) - 1;
}

/// Effective permission bitfield for a member. The owner implicitly has every
/// permission; everyone else gets the union of their assigned roles.
pub async fn member_permissions(state: &AppState, server_id: &str, user_id: &str) -> i64 {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    if owner.as_deref() == Some(user_id) {
        return perm::ALL;
    }
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT r.permissions FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? AND mr.user_id = ?",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    rows.into_iter().fold(0i64, |acc, (p,)| acc | p)
}

pub async fn has_perm(state: &AppState, server_id: &str, user_id: &str, flag: i64) -> bool {
    member_permissions(state, server_id, user_id).await & flag != 0
}

/// A member's rank for hierarchy checks: the owner outranks everyone (i64::MAX),
/// otherwise their highest assigned role position (-1 if they have no roles).
pub async fn member_top_position(state: &AppState, server_id: &str, user_id: &str) -> i64 {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    if owner.as_deref() == Some(user_id) {
        return i64::MAX;
    }
    sqlx::query_scalar(
        "SELECT COALESCE(MAX(r.position), -1) FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? AND mr.user_id = ?",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(-1)
}

async fn is_member(state: &AppState, server_id: &str, user_id: &str) -> bool {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    row.is_some()
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MyPermissions {
    pub permissions: i64,
}

/// GET /servers/{server_id}/me/permissions — the caller's effective permissions.
pub async fn my_permissions(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MyPermissions>, (StatusCode, String)> {
    Ok(Json(MyPermissions {
        permissions: member_permissions(&state, &server_id, &auth.0).await,
    }))
}

/// GET /servers/{server_id}/roles — list a server's roles (members only).
pub async fn list_roles(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<Role>>, (StatusCode, String)> {
    if !is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let roles: Vec<Role> =
        sqlx::query_as("SELECT * FROM roles WHERE server_id = ? ORDER BY position, created_at")
            .bind(&server_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
    Ok(Json(roles))
}

#[derive(Deserialize)]
pub struct CreateRoleBody {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub permissions: i64,
}

/// POST /servers/{server_id}/roles — create a role (needs MANAGE_ROLES).
pub async fn create_role(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateRoleBody>,
) -> Result<Json<Role>, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "role name required".into()));
    }
    // A non-owner can never grant permissions they don't themselves hold.
    let mine = member_permissions(&state, &server_id, &auth.0).await;
    let granted = body.permissions & mine & perm::ALL;

    // New roles rank above existing ones (creation order = hierarchy in v1).
    let position: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(position), 0) + 1 FROM roles WHERE server_id = ?")
            .bind(&server_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(1);

    let role = Role {
        id: new_id(),
        server_id: server_id.clone(),
        name: name.to_owned(),
        color: body.color,
        permissions: granted,
        position,
        created_at: now_unix(),
    };
    sqlx::query(
        "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&role.id)
    .bind(&role.server_id)
    .bind(&role.name)
    .bind(&role.color)
    .bind(role.permissions)
    .bind(role.position)
    .bind(role.created_at)
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;

    Ok(Json(role))
}

/// DELETE /servers/{server_id}/roles/{role_id} — delete a role (needs MANAGE_ROLES).
pub async fn delete_role(
    auth: AuthUser,
    Path((server_id, role_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    sqlx::query("DELETE FROM roles WHERE id = ? AND server_id = ?")
        .bind(&role_id)
        .bind(&server_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    // Anyone who held this role just lost permissions — refresh the whole server.
    broadcast_to_server(
        &state,
        &server_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /servers/{server_id}/members/{user_id}/roles/{role_id} — assign a role.
pub async fn assign_role(
    auth: AuthUser,
    Path((server_id, user_id, role_id)): Path<(String, String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    // Role must belong to this server, and target must be a member.
    let role_ok: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM roles WHERE id = ? AND server_id = ?")
            .bind(&role_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    if role_ok.is_none() || !is_member(&state, &server_id, &user_id).await {
        return Err((StatusCode::NOT_FOUND, "role or member not found".into()));
    }
    sqlx::query("INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?,?,?)")
        .bind(&server_id)
        .bind(&user_id)
        .bind(&role_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    // Push the affected member a live permissions refresh.
    broadcast_to_user(
        &state.sessions,
        &user_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/{server_id}/members/{user_id}/roles/{role_id} — unassign.
pub async fn unassign_role(
    auth: AuthUser,
    Path((server_id, user_id, role_id)): Path<(String, String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    sqlx::query("DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?")
        .bind(&server_id)
        .bind(&user_id)
        .bind(&role_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    broadcast_to_user(
        &state.sessions,
        &user_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// GET /servers/{server_id}/members/{user_id}/roles — role ids a member holds.
pub async fn member_role_ids(
    auth: AuthUser,
    Path((server_id, user_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    if !is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let ids: Vec<(String,)> =
        sqlx::query_as("SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?")
            .bind(&server_id)
            .bind(&user_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
    Ok(Json(ids.into_iter().map(|(id,)| id).collect()))
}
