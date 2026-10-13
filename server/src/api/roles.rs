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
    pub const MANAGE_SERVER: i64 = 1 << 5;
    pub const VIEW_CHANNEL: i64 = 1 << 6;
    pub const SEND_MESSAGES: i64 = 1 << 7;
    pub const ADMINISTRATOR: i64 = 1 << 8;
    /// Time members out (they can read, but not post, react or join voice).
    pub const MODERATE_MEMBERS: i64 = 1 << 9;
    /// Make invite links. On for everyone by default; a space can take it away.
    pub const CREATE_INVITE: i64 = 1 << 10;
    pub const LEGACY_MANAGE_ALL: i64 = (1 << 6) - 1;
    pub const ALL: i64 = (1 << 11) - 1;
    pub const DEFAULT_MEMBER: i64 = VIEW_CHANNEL | SEND_MESSAGES | CREATE_INVITE;
}

/// Effective server-level permission bitfield for a member. The owner implicitly has
/// every permission. Everyone else gets the @everyone role/defaults plus assigned roles.
pub async fn member_permissions(state: &AppState, server_id: &str, user_id: &str) -> i64 {
    base_member_permissions(state, server_id, user_id).await
}

pub async fn has_perm(state: &AppState, server_id: &str, user_id: &str, flag: i64) -> bool {
    member_permissions(state, server_id, user_id).await & flag != 0
}

async fn is_owner(state: &AppState, server_id: &str, user_id: &str) -> bool {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    owner.as_deref() == Some(user_id)
}

async fn member_role_ids_and_permissions(
    state: &AppState,
    server_id: &str,
    user_id: &str,
) -> (Vec<String>, i64) {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT r.id, r.permissions FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? AND mr.user_id = ? AND r.is_everyone = 0",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let mut ids = Vec::with_capacity(rows.len());
    let mut permissions = 0;
    for (id, p) in rows {
        ids.push(id);
        permissions |= p;
    }
    (ids, permissions)
}

async fn everyone_permissions(state: &AppState, server_id: &str) -> i64 {
    sqlx::query_scalar("SELECT permissions FROM roles WHERE server_id = ? AND is_everyone = 1 ORDER BY created_at LIMIT 1")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or(perm::DEFAULT_MEMBER)
}

async fn base_member_permissions(state: &AppState, server_id: &str, user_id: &str) -> i64 {
    if is_owner(state, server_id, user_id).await {
        return perm::ALL;
    }
    if !crate::api::servers::is_member(state, server_id, user_id).await {
        return 0;
    }
    let (_, role_permissions) = member_role_ids_and_permissions(state, server_id, user_id).await;
    everyone_permissions(state, server_id).await | role_permissions
}

fn has_admin_override(permissions: i64) -> bool {
    permissions & perm::ADMINISTRATOR != 0
        || permissions & perm::LEGACY_MANAGE_ALL == perm::LEGACY_MANAGE_ALL
}

/// One permission overwrite: `(target_type, target_id, allow, deny)`.
type Overwrite = (String, Option<String>, i64, i64);

async fn apply_overwrite_scope(
    state: &AppState,
    permissions: i64,
    scope_type: &str,
    scope_id: &str,
    user_id: &str,
    role_ids: &[String],
) -> i64 {
    let rows: Vec<Overwrite> = sqlx::query_as(
        "SELECT target_type, target_id, allow_permissions, deny_permissions
         FROM permission_overwrites
         WHERE scope_type = ? AND scope_id = ?",
    )
    .bind(scope_type)
    .bind(scope_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    apply_overwrites(permissions, &rows, user_id, role_ids)
}

/// Apply one scope's overwrites: @everyone, then the member's roles combined, then the
/// member; deny then allow at each level.
fn apply_overwrites(
    mut permissions: i64,
    rows: &[Overwrite],
    user_id: &str,
    role_ids: &[String],
) -> i64 {
    let mut deny = 0;
    let mut allow = 0;
    for (target_type, _target_id, allow_permissions, deny_permissions) in rows {
        if target_type == "everyone" {
            deny |= *deny_permissions;
            allow |= *allow_permissions;
        }
    }
    permissions &= !deny;
    permissions |= allow;

    deny = 0;
    allow = 0;
    for (target_type, target_id, allow_permissions, deny_permissions) in rows {
        if target_type == "role" && target_id.as_ref().is_some_and(|id| role_ids.contains(id)) {
            deny |= *deny_permissions;
            allow |= *allow_permissions;
        }
    }
    permissions &= !deny;
    permissions |= allow;

    deny = 0;
    allow = 0;
    for (target_type, target_id, allow_permissions, deny_permissions) in rows {
        if target_type == "member" && target_id.as_deref() == Some(user_id) {
            deny |= *deny_permissions;
            allow |= *allow_permissions;
        }
    }
    permissions &= !deny;
    permissions |= allow;
    permissions
}

/// The channel a thread hangs off, or None when `channel_id` isn't a thread.
pub async fn thread_parent(state: &AppState, channel_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .flatten()
}

/// Effective Discord-style channel permissions: server/@everyone base, unioned member
/// roles, administrator override, then category and channel overwrites with Discord's
/// level ordering: @everyone, combined roles, member-specific; deny then allow per level.
pub async fn channel_permissions(state: &AppState, channel_id: &str, user_id: &str) -> i64 {
    // A thread has no permissions of its own: it takes its parent channel's, so hiding a
    // channel (or a category) hides its threads with it.
    let scope_channel = thread_parent(state, channel_id)
        .await
        .unwrap_or_else(|| channel_id.to_owned());
    let channel_id = scope_channel.as_str();
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT server_id, category_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let Some((Some(server_id), category_id)) = row else {
        return 0;
    };
    if is_owner(state, &server_id, user_id).await {
        return perm::ALL;
    }
    if !crate::api::servers::is_member(state, &server_id, user_id).await {
        return 0;
    }
    let (role_ids, role_permissions) =
        member_role_ids_and_permissions(state, &server_id, user_id).await;
    let mut permissions = everyone_permissions(state, &server_id).await | role_permissions;
    if has_admin_override(permissions) {
        return perm::ALL;
    }
    if let Some(category_id) = category_id {
        permissions = apply_overwrite_scope(
            state,
            permissions,
            "category",
            &category_id,
            user_id,
            &role_ids,
        )
        .await;
    }
    apply_overwrite_scope(
        state,
        permissions,
        "channel",
        channel_id,
        user_id,
        &role_ids,
    )
    .await
}

pub async fn has_channel_perm(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
    flag: i64,
) -> bool {
    channel_permissions(state, channel_id, user_id).await & flag != 0
}

/// The channels of `server_id` (as loaded from it) that `user_id` may view, by the same
/// rules as [`channel_permissions`]. The member's base permissions are resolved once and
/// the overwrites of every channel and category in `channels` are read in one query, so
/// the cost does not grow with the channel count. The query takes its scopes from
/// `channels` itself, so a channel moved or deleted since the list was loaded is still
/// judged with the overwrites it had in that list. An error reading the overwrites
/// returns the error rather than listing channels whose denies could not be checked.
pub async fn viewable_channels(
    state: &AppState,
    server_id: &str,
    user_id: &str,
    channels: Vec<crate::types::Channel>,
) -> Result<Vec<crate::types::Channel>, sqlx::Error> {
    if is_owner(state, server_id, user_id).await {
        return Ok(channels);
    }
    if !crate::api::servers::is_member(state, server_id, user_id).await {
        return Ok(Vec::new());
    }
    let (role_ids, role_permissions) =
        member_role_ids_and_permissions(state, server_id, user_id).await;
    let base = everyone_permissions(state, server_id).await | role_permissions;
    if has_admin_override(base) {
        return Ok(channels);
    }
    let json_list =
        |ids: Vec<&str>| serde_json::to_string(&ids).map_err(|e| sqlx::Error::Encode(Box::new(e)));
    let channel_ids = json_list(channels.iter().map(|c| c.id.as_str()).collect())?;
    let category_ids = json_list(
        channels
            .iter()
            .filter_map(|c| c.category_id.as_deref())
            .collect(),
    )?;
    let rows: Vec<(String, String, String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions
         FROM permission_overwrites
         WHERE (scope_type = 'channel' AND scope_id IN (SELECT value FROM json_each(?)))
            OR (scope_type = 'category' AND scope_id IN (SELECT value FROM json_each(?)))",
    )
    .bind(channel_ids)
    .bind(category_ids)
    .fetch_all(&state.db)
    .await?;
    let mut by_scope: std::collections::HashMap<(String, String), Vec<Overwrite>> =
        std::collections::HashMap::new();
    for (scope_type, scope_id, target_type, target_id, allow, deny) in rows {
        by_scope.entry((scope_type, scope_id)).or_default().push((
            target_type,
            target_id,
            allow,
            deny,
        ));
    }
    let scope = |scope_type: &str, scope_id: &str| -> &[Overwrite] {
        by_scope
            .get(&(scope_type.to_owned(), scope_id.to_owned()))
            .map_or(&[], Vec::as_slice)
    };
    let can_view = |channel: &crate::types::Channel| {
        let mut permissions = base;
        if let Some(category_id) = &channel.category_id {
            permissions = apply_overwrites(
                permissions,
                scope("category", category_id),
                user_id,
                &role_ids,
            );
        }
        permissions = apply_overwrites(
            permissions,
            scope("channel", &channel.id),
            user_id,
            &role_ids,
        );
        permissions & perm::VIEW_CHANNEL != 0
    };
    // A thread is judged by its parent channel, which must be in the same list.
    let parents: std::collections::HashMap<&str, &crate::types::Channel> = channels
        .iter()
        .filter(|c| c.parent_id.is_none())
        .map(|c| (c.id.as_str(), c))
        .collect();
    let visible: Vec<bool> = channels
        .iter()
        .map(|channel| match channel.parent_id.as_deref() {
            Some(parent) => parents.get(parent).is_some_and(|p| can_view(p)),
            None => can_view(channel),
        })
        .collect();
    Ok(channels
        .into_iter()
        .zip(visible)
        .filter_map(|(channel, visible)| visible.then_some(channel))
        .collect())
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
    /// When the caller's time out in this space ends (unix seconds); None when they aren't
    /// timed out.
    pub timed_out_until: Option<i64>,
}

/// GET /servers/{server_id}/me/permissions — the caller's effective permissions.
pub async fn my_permissions(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MyPermissions>, (StatusCode, String)> {
    Ok(Json(MyPermissions {
        permissions: member_permissions(&state, &server_id, &auth.0).await,
        timed_out_until: crate::api::moderation::active_timeout(&state, &server_id, &auth.0).await,
    }))
}

/// The @everyone permissions of a space: its @everyone role's, or the default for a space
/// that has none (every space not imported from Discord).
pub async fn everyone_permissions_of(state: &AppState, server_id: &str) -> i64 {
    everyone_permissions(state, server_id).await
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
            .map_err(crate::api::error::internal)?;
    Ok(Json(roles))
}

#[derive(Deserialize)]
pub struct CreateRoleBody {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub permissions: i64,
    #[serde(default)]
    pub hoist: bool,
}

/// A role colour is `#rrggbb`.
pub fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Permissions a member can hand out: everything for the owner or an administrator,
/// otherwise exactly what they hold.
async fn grantable(state: &AppState, server_id: &str, user_id: &str) -> i64 {
    let mine = member_permissions(state, server_id, user_id).await;
    if has_admin_override(mine) {
        perm::ALL
    } else {
        mine
    }
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
    crate::api::limits::check_len("role name", name, crate::api::limits::ROLE_NAME)?;
    if body.color.as_deref().is_some_and(|c| !valid_color(c)) {
        return Err((
            StatusCode::BAD_REQUEST,
            "a role colour looks like #3fa7ff".into(),
        ));
    }
    // A non-owner can never grant permissions they don't themselves hold.
    let mine = member_permissions(&state, &server_id, &auth.0).await;
    let granted = body.permissions & mine & perm::ALL;

    // The owner's new roles rank above existing ones (creation order = hierarchy in v1).
    // Anyone else's take the rank of their own top role, which moves up one together with
    // every role above it: the new role sits directly below the creator, who can then
    // assign and delete it, and every other role keeps its order. Without a role of their
    // own, anything they made would rank at or above them.
    let creator_top = member_top_position(&state, &server_id, &auth.0).await;
    let by_owner = creator_top == i64::MAX;
    let position: i64 = if by_owner {
        sqlx::query_scalar("SELECT COALESCE(MAX(position), 0) + 1 FROM roles WHERE server_id = ?")
            .bind(&server_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(1)
    } else if creator_top >= 0 {
        creator_top
    } else {
        return Err((
            StatusCode::FORBIDDEN,
            "you need a role of your own to create roles below it".into(),
        ));
    };
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    if !by_owner {
        sqlx::query(
            "UPDATE roles SET position = position + 1 WHERE server_id = ? AND position >= ?",
        )
        .bind(&server_id)
        .bind(position)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    }

    let role = Role {
        id: new_id(),
        server_id: server_id.clone(),
        name: name.to_owned(),
        color: body.color,
        permissions: granted,
        position,
        created_at: now_unix(),
        is_everyone: false,
        hoist: body.hoist,
    };
    sqlx::query(
        "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at, is_everyone, hoist) VALUES (?,?,?,?,?,?,?,0,?)",
    )
    .bind(&role.id)
    .bind(&role.server_id)
    .bind(&role.name)
    .bind(&role.color)
    .bind(role.permissions)
    .bind(role.position)
    .bind(role.created_at)
    .bind(role.hoist)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    tx.commit().await.map_err(crate::api::error::internal)?;
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;

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
    let role: Option<(bool, i64)> =
        sqlx::query_as("SELECT is_everyone, position FROM roles WHERE id = ? AND server_id = ?")
            .bind(&role_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if role.is_some_and(|(is_everyone, _)| is_everyone) {
        return Err((
            StatusCode::BAD_REQUEST,
            "@everyone cannot be deleted".into(),
        ));
    }
    // Same hierarchy rule as assign_role: only roles ranked below your own top role.
    // The owner is exempt — member_top_position → i64::MAX.
    if let Some((_, role_position)) = role {
        if role_position >= member_top_position(&state, &server_id, &auth.0).await {
            return Err((
                StatusCode::FORBIDDEN,
                "you can't delete a role ranked at or above your own".into(),
            ));
        }
    }
    sqlx::query("DELETE FROM roles WHERE id = ? AND server_id = ?")
        .bind(&role_id)
        .bind(&server_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    // Anyone who held this role just lost permissions — refresh the whole server.
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;
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
    let role_row: Option<(i64, i64)> =
        sqlx::query_as("SELECT position, permissions FROM roles WHERE id = ? AND server_id = ?")
            .bind(&role_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let role_is_everyone: Option<bool> =
        sqlx::query_scalar("SELECT is_everyone FROM roles WHERE id = ? AND server_id = ?")
            .bind(&role_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if role_is_everyone == Some(true) {
        return Err((StatusCode::BAD_REQUEST, "@everyone is automatic".into()));
    }
    let Some((role_position, role_permissions)) = role_row else {
        return Err((StatusCode::NOT_FOUND, "role or member not found".into()));
    };
    if !is_member(&state, &server_id, &user_id).await {
        return Err((StatusCode::NOT_FOUND, "role or member not found".into()));
    }
    // Anti-escalation: you can't hand out a role ranked at or above your own top role,
    // nor one carrying permissions you don't hold yourself. The owner is exempt —
    // member_top_position → i64::MAX and member_permissions → ALL, so both guards pass.
    if role_position >= member_top_position(&state, &server_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't assign a role ranked at or above your own".into(),
        ));
    }
    if role_permissions & !member_permissions(&state, &server_id, &auth.0).await & perm::ALL != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't grant permissions you don't have".into(),
        ));
    }
    sqlx::query("INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?,?,?)")
        .bind(&server_id)
        .bind(&user_id)
        .bind(&role_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    // Name colours and member-list groups follow who holds what, for everyone in the space.
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;
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
    // Same hierarchy rule as assign_role (the owner is exempt via i64::MAX): the role
    // must rank below your own top role, and so must the member, unless it's you.
    let role_position: Option<i64> =
        sqlx::query_scalar("SELECT position FROM roles WHERE id = ? AND server_id = ?")
            .bind(&role_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let actor_top = member_top_position(&state, &server_id, &auth.0).await;
    if role_position.is_some_and(|position| position >= actor_top) {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't remove a role ranked at or above your own".into(),
        ));
    }
    if user_id != auth.0 && member_top_position(&state, &server_id, &user_id).await >= actor_top {
        return Err((
            StatusCode::FORBIDDEN,
            "that member ranks too high for you to act on".into(),
        ));
    }
    sqlx::query("DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?")
        .bind(&server_id)
        .bind(&user_id)
        .bind(&role_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;
    broadcast_to_user(
        &state.sessions,
        &user_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct UpdateRoleBody {
    #[serde(default)]
    pub name: Option<String>,
    /// `null` clears the colour; absent leaves it.
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub permissions: Option<i64>,
    #[serde(default)]
    pub hoist: Option<bool>,
}

fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// PATCH /servers/{server_id}/roles/{role_id} — edit a role's name, colour, permissions or
/// "show members separately". Needs Manage roles, only for roles ranked below your own, and
/// a change to its permissions may only touch permissions you hold yourself.
pub async fn update_role(
    auth: AuthUser,
    Path((server_id, role_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<UpdateRoleBody>,
) -> Result<Json<Role>, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    let role: Option<Role> = sqlx::query_as("SELECT * FROM roles WHERE id = ? AND server_id = ?")
        .bind(&role_id)
        .bind(&server_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let Some(mut role) = role else {
        return Err((StatusCode::NOT_FOUND, "role not found".into()));
    };
    if !role.is_everyone && role.position >= member_top_position(&state, &server_id, &auth.0).await
    {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't edit a role ranked at or above your own".into(),
        ));
    }
    if let Some(name) = body.name.as_deref() {
        let name = name.trim();
        if name.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "role name required".into()));
        }
        if role.is_everyone && name != role.name {
            return Err((StatusCode::BAD_REQUEST, "@everyone keeps its name".into()));
        }
        crate::api::limits::check_len("role name", name, crate::api::limits::ROLE_NAME)?;
        role.name = name.to_owned();
    }
    if let Some(color) = body.color {
        if color.as_deref().is_some_and(|c| !valid_color(c)) {
            return Err((
                StatusCode::BAD_REQUEST,
                "a role colour looks like #3fa7ff".into(),
            ));
        }
        role.color = color.map(|c| c.to_ascii_lowercase());
    }
    if let Some(permissions) = body.permissions {
        let permissions = permissions & perm::ALL;
        let changed = permissions ^ role.permissions;
        if changed & !grantable(&state, &server_id, &auth.0).await != 0 {
            return Err((
                StatusCode::FORBIDDEN,
                "you can't change permissions you don't have".into(),
            ));
        }
        role.permissions = permissions;
    }
    if let Some(hoist) = body.hoist {
        role.hoist = hoist && !role.is_everyone;
    }
    sqlx::query("UPDATE roles SET name = ?, color = ?, permissions = ?, hoist = ? WHERE id = ?")
        .bind(&role.name)
        .bind(&role.color)
        .bind(role.permissions)
        .bind(role.hoist)
        .bind(&role.id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    crate::api::abuse::log_action(
        &state,
        crate::api::abuse::ActionLog {
            server_id: Some(&server_id),
            actor_id: &auth.0,
            action: "update_role",
            target_type: "role",
            target_id: &role.id,
            report_id: None,
            metadata: Some(&serde_json::json!({ "name": role.name }).to_string()),
        },
    )
    .await?;
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;
    broadcast_to_server(
        &state,
        &server_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    )
    .await;
    Ok(Json(role))
}

#[derive(Deserialize)]
pub struct RoleOrderBody {
    /// The roles you may move, highest first.
    pub role_ids: Vec<String>,
}

/// PUT /servers/{server_id}/role-order — reorder the roles ranked below your own. The
/// list must name exactly those roles, highest first; they take the same rank slots in the
/// new order, so every role at or above yours keeps its place.
pub async fn reorder_roles(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<RoleOrderBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !has_perm(&state, &server_id, &auth.0, perm::MANAGE_ROLES).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage roles".into()));
    }
    let top = member_top_position(&state, &server_id, &auth.0).await;
    let movable: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, position FROM roles WHERE server_id = ? AND is_everyone = 0 AND position < ?
         ORDER BY position DESC, created_at DESC",
    )
    .bind(&server_id)
    .bind(top)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let mut wanted: Vec<&String> = body.role_ids.iter().collect();
    let mut have: Vec<&String> = movable.iter().map(|(id, _)| id).collect();
    wanted.sort();
    have.sort();
    if wanted != have {
        return Err((
            StatusCode::FORBIDDEN,
            "you can only reorder the roles ranked below your own, all of them".into(),
        ));
    }
    let slots: Vec<i64> = movable.iter().map(|(_, position)| *position).collect();
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    for (role_id, position) in body.role_ids.iter().zip(slots) {
        sqlx::query("UPDATE roles SET position = ? WHERE id = ? AND server_id = ?")
            .bind(position)
            .bind(role_id)
            .bind(&server_id)
            .execute(&mut *tx)
            .await
            .map_err(crate::api::error::internal)?;
    }
    tx.commit().await.map_err(crate::api::error::internal)?;
    crate::api::abuse::log_action(
        &state,
        crate::api::abuse::ActionLog {
            server_id: Some(&server_id),
            actor_id: &auth.0,
            action: "reorder_roles",
            target_type: "server",
            target_id: &server_id,
            report_id: None,
            metadata: None,
        },
    )
    .await?;
    crate::api::servers::broadcast_full_server_to_members(&state, &server_id).await;
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
            .map_err(crate::api::error::internal)?;
    Ok(Json(ids.into_iter().map(|(id,)| id).collect()))
}
