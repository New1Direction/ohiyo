use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    api::servers::fetch_full,
    auth::AuthUser,
    gateway::{broadcast_to_channel, broadcast_to_server},
    types::{new_id, now_unix, Category, Channel, GatewayEvent},
    AppState,
};

async fn can_manage(state: &AppState, server_id: &str, user_id: &str) -> bool {
    crate::api::roles::has_perm(
        state,
        server_id,
        user_id,
        crate::api::roles::perm::MANAGE_CHANNELS,
    )
    .await
}

/// Reload + broadcast the whole server so every client picks up structural changes.
async fn broadcast_server(state: &AppState, server_id: &str) {
    if let Ok(full) = fetch_full(server_id, state).await {
        broadcast_to_server(state, server_id, &GatewayEvent::ServerCreate(full)).await;
    }
}

pub async fn list_channels(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<Channel>>, (StatusCode, String)> {
    if !crate::api::servers::is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
    }
    let channels: Vec<Channel> =
        sqlx::query_as("SELECT * FROM channels WHERE server_id = ? ORDER BY position")
            .bind(&server_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;

    Ok(Json(channels))
}

#[derive(Deserialize)]
pub struct CreateChannelBody {
    pub name: String,
    #[serde(default = "default_type")]
    pub channel_type: String,
    pub position: Option<i64>,
    pub topic: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
}

fn default_type() -> String {
    "text".to_owned()
}

pub async fn create_channel(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateChannelBody>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    if !can_manage(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage channels".into()));
    }
    let id = new_id();
    let now = now_unix();
    let position = body.position.unwrap_or(0);
    let category_id = body.category_id.filter(|c| !c.is_empty());

    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position, topic, created_at, category_id)
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(body.name.trim())
    .bind(&body.channel_type)
    .bind(position)
    .bind(&body.topic)
    .bind(now)
    .bind(&category_id)
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;

    let channel = Channel {
        id,
        server_id: Some(server_id),
        name: body.name,
        channel_type: body.channel_type,
        position,
        topic: body.topic,
        created_at: now,
        category_id,
        disappearing_seconds: None,
        epoch: 0,
        owner_id: None,
    };

    broadcast_to_channel(
        &state,
        &channel.id,
        &GatewayEvent::ChannelCreate(channel.clone()),
    )
    .await;
    Ok(Json(channel))
}

#[derive(Deserialize)]
pub struct CreateCategoryBody {
    pub name: String,
}

/// POST /servers/{server_id}/categories — add a category (needs MANAGE_CHANNELS).
pub async fn create_category(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateCategoryBody>,
) -> Result<Json<Category>, (StatusCode, String)> {
    if !can_manage(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage channels".into()));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "category name required".into()));
    }
    let position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE server_id = ?",
    )
    .bind(&server_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(1);
    let category = Category {
        id: new_id(),
        server_id: server_id.clone(),
        name: name.to_owned(),
        position,
        created_at: now_unix(),
    };
    sqlx::query(
        "INSERT INTO categories (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&category.id)
    .bind(&category.server_id)
    .bind(&category.name)
    .bind(category.position)
    .bind(category.created_at)
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;

    broadcast_server(&state, &server_id).await;
    Ok(Json(category))
}

/// DELETE /servers/{server_id}/categories/{category_id} — channels become uncategorized.
pub async fn delete_category(
    auth: AuthUser,
    Path((server_id, category_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !can_manage(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage channels".into()));
    }
    sqlx::query("DELETE FROM categories WHERE id = ? AND server_id = ?")
        .bind(&category_id)
        .bind(&server_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    broadcast_server(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct MoveChannelBody {
    pub category_id: Option<String>,
}

/// PUT /servers/{server_id}/channels/{channel_id}/category — move a channel.
pub async fn set_channel_category(
    auth: AuthUser,
    Path((server_id, channel_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<MoveChannelBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !can_manage(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "you can't manage channels".into()));
    }
    let category_id = body.category_id.filter(|c| !c.is_empty());
    sqlx::query("UPDATE channels SET category_id = ? WHERE id = ? AND server_id = ?")
        .bind(&category_id)
        .bind(&channel_id)
        .bind(&server_id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    broadcast_server(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_channel(
    auth: AuthUser,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let can = match row.and_then(|(s,)| s) {
        Some(sid) => {
            crate::api::roles::has_perm(
                &state,
                &sid,
                &auth.0,
                crate::api::roles::perm::MANAGE_CHANNELS,
            )
            .await
        }
        None => false,
    };
    if !can {
        return Err((StatusCode::FORBIDDEN, "you can't manage channels".into()));
    }

    sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;

    Ok(StatusCode::NO_CONTENT)
}
