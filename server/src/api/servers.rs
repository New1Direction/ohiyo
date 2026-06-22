use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_server,
    types::{
        new_id, now_unix, Category, GatewayEvent, PublicUser, Server, ServerWithChannels, User,
    },
    AppState,
};

pub async fn list_servers(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ServerWithChannels>>, (StatusCode, String)> {
    let servers: Vec<Server> = sqlx::query_as(
        "SELECT s.* FROM servers s
         JOIN server_members sm ON sm.server_id = s.id
         WHERE sm.user_id = ?",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    // Fetch each server's full payload concurrently (WAL + pooled connections) instead
    // of N serial round-trips, matching the concurrent pattern in the gateway Ready path.
    let out: Vec<ServerWithChannels> =
        futures_util::future::join_all(servers.iter().map(|server| fetch_full(&server.id, &state)))
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(out))
}

/// True if the user is a member of the server.
pub async fn is_member(state: &AppState, server_id: &str, user_id: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map(|n| n > 0)
    .unwrap_or(false)
}

pub async fn get_server(
    auth: AuthUser,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<ServerWithChannels>, (StatusCode, String)> {
    if !is_member(&state, &id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
    }
    Ok(Json(fetch_full(&id, &state).await?))
}

#[derive(Deserialize)]
pub struct CreateServerBody {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SetServerIconBody {
    pub file_id: String,
}

pub async fn create_server(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateServerBody>,
) -> Result<Json<ServerWithChannels>, (StatusCode, String)> {
    if body.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name required".into()));
    }

    let server_id = new_id();
    let now = now_unix();

    sqlx::query("INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)")
        .bind(&server_id)
        .bind(body.name.trim())
        .bind(&auth.0)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    // Add owner as member.
    sqlx::query("INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)")
        .bind(&server_id)
        .bind(&auth.0)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    // Seed a fresh server so it feels alive on first open: a #general text
    // channel plus a "General" voice room — voice is one click away, no setup.
    let seed_channels: [(&str, &str, i64); 2] = [("general", "text", 0), ("General", "voice", 1)];
    for (name, kind, position) in seed_channels {
        sqlx::query(
            "INSERT INTO channels (id, server_id, name, channel_type, position, created_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(new_id())
        .bind(&server_id)
        .bind(name)
        .bind(kind)
        .bind(position)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    }

    let full = fetch_full(&server_id, &state).await?;
    broadcast_to_server(
        &state,
        &full.server.id,
        &GatewayEvent::ServerCreate(full.clone()),
    )
    .await;
    Ok(Json(full))
}

/// POST /servers/{id}/icon — set a real server logo shown in the rail/invites.
pub async fn set_server_icon(
    auth: AuthUser,
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<SetServerIconBody>,
) -> Result<Json<ServerWithChannels>, (StatusCode, String)> {
    if !crate::api::roles::has_perm(&state, &id, &auth.0, crate::api::roles::perm::MANAGE_SERVER)
        .await
    {
        return Err((
            StatusCode::FORBIDDEN,
            "you don't have permission for that".into(),
        ));
    }

    let file: Option<(String,)> =
        sqlx::query_as("SELECT content_type FROM files WHERE id = ? AND uploader_id = ?")
            .bind(&body.file_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    let Some((content_type,)) = file else {
        return Err((StatusCode::NOT_FOUND, "File not found".into()));
    };
    if !content_type.starts_with("image/") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Server logo must be an image".into(),
        ));
    }

    let icon_url = crate::signed_file_url(&crate::public_base_url(), &body.file_id);
    sqlx::query("UPDATE servers SET icon_url = ? WHERE id = ?")
        .bind(&icon_url)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let full = fetch_full(&id, &state).await?;
    broadcast_to_server(&state, &id, &GatewayEvent::ServerCreate(full.clone())).await;
    Ok(Json(full))
}

pub async fn leave_server(
    auth: AuthUser,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    // The owner can't abandon their server (it would be left unownable).
    let owner_id: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    if owner_id.as_deref() == Some(auth.0.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "delete the server instead of leaving — you own it".into(),
        ));
    }

    // Announce before removing so the leaver still receives it as a member.
    broadcast_to_server(
        &state,
        &id,
        &GatewayEvent::MemberLeave {
            server_id: id.clone(),
            user_id: auth.0.clone(),
        },
    )
    .await;

    sqlx::query("DELETE FROM server_members WHERE server_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// Shared: caller must hold `flag` and the target must not be the owner.
async fn require_mod_action(
    state: &AppState,
    server_id: &str,
    actor_id: &str,
    target_id: &str,
    flag: i64,
) -> Result<(), (StatusCode, String)> {
    let owner_id: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let owner_id = owner_id.ok_or((StatusCode::NOT_FOUND, "server not found".into()))?;
    if target_id == owner_id {
        return Err((StatusCode::BAD_REQUEST, "the owner can't be removed".into()));
    }
    if !crate::api::roles::has_perm(state, server_id, actor_id, flag).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you don't have permission for that".into(),
        ));
    }
    // Hierarchy: you can only act on members ranked below you.
    let actor_rank = crate::api::roles::member_top_position(state, server_id, actor_id).await;
    let target_rank = crate::api::roles::member_top_position(state, server_id, target_id).await;
    if actor_rank <= target_rank {
        return Err((
            StatusCode::FORBIDDEN,
            "that member ranks too high for you to act on".into(),
        ));
    }
    Ok(())
}

/// Remove a member from a server, announcing it before the row disappears.
async fn remove_member(
    state: &AppState,
    server_id: &str,
    target_id: &str,
) -> Result<(), (StatusCode, String)> {
    broadcast_to_server(
        state,
        server_id,
        &GatewayEvent::MemberLeave {
            server_id: server_id.to_string(),
            user_id: target_id.to_string(),
        },
    )
    .await;
    sqlx::query("DELETE FROM server_members WHERE server_id = ? AND user_id = ?")
        .bind(server_id)
        .bind(target_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(())
}

/// POST /servers/{server_id}/bans/{user_id} — owner bans (and removes) a member.
pub async fn ban_member(
    auth: AuthUser,
    Path((server_id, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_mod_action(
        &state,
        &server_id,
        &auth.0,
        &target_id,
        crate::api::roles::perm::BAN_MEMBERS,
    )
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO server_bans (server_id, user_id, banned_by, banned_at) VALUES (?,?,?,?)",
    )
    .bind(&server_id)
    .bind(&target_id)
    .bind(&auth.0)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    remove_member(&state, &server_id, &target_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/{server_id}/bans/{user_id} — owner lifts a ban.
pub async fn unban_member(
    auth: AuthUser,
    Path((server_id, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_mod_action(
        &state,
        &server_id,
        &auth.0,
        &target_id,
        crate::api::roles::perm::BAN_MEMBERS,
    )
    .await?;
    sqlx::query("DELETE FROM server_bans WHERE server_id = ? AND user_id = ?")
        .bind(&server_id)
        .bind(&target_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// True if a user is banned from a server.
pub async fn is_banned(state: &AppState, server_id: &str, user_id: &str) -> bool {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    row.is_some()
}

/// DELETE /servers/{id}/members/{user_id} — owner removes (kicks) a member.
pub async fn kick_member(
    auth: AuthUser,
    Path((server_id, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_mod_action(
        &state,
        &server_id,
        &auth.0,
        &target_id,
        crate::api::roles::perm::KICK_MEMBERS,
    )
    .await?;
    remove_member(&state, &server_id, &target_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_server(
    auth: AuthUser,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let server: Option<Server> =
        sqlx::query_as("SELECT * FROM servers WHERE id = ? AND owner_id = ?")
            .bind(&id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    if server.is_none() {
        return Err((StatusCode::FORBIDDEN, "not the owner".into()));
    }

    // Notify members BEFORE deleting — the cascade removes server_members rows,
    // so we must resolve recipients while they still exist.
    broadcast_to_server(&state, &id, &GatewayEvent::ServerDelete { id: id.clone() }).await;

    sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    Ok(StatusCode::NO_CONTENT)
}

// ── Internal helper ───────────────────────────────────────────────────────────

pub async fn fetch_full(
    server_id: &str,
    state: &AppState,
) -> Result<ServerWithChannels, (StatusCode, String)> {
    let server: Server = sqlx::query_as("SELECT * FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_one(&state.db)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "server not found".into()))?;

    let channels = sqlx::query_as("SELECT * FROM channels WHERE server_id = ? ORDER BY position")
        .bind(server_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

    let members: Vec<User> = sqlx::query_as(
        "SELECT u.* FROM users u
         JOIN server_members sm ON sm.user_id = u.id
         WHERE sm.server_id = ?",
    )
    .bind(server_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let categories: Vec<Category> =
        sqlx::query_as("SELECT * FROM categories WHERE server_id = ? ORDER BY position")
            .bind(server_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

    Ok(ServerWithChannels {
        server,
        channels,
        members: members.into_iter().map(PublicUser::from).collect(),
        categories,
    })
}
