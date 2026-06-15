use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};

#[derive(Serialize, Clone)]
pub struct ServerEmoji {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub url: String,
    pub created_by: String,
    pub created_at: i64,
}

#[derive(sqlx::FromRow)]
struct EmojiRow {
    id: String,
    server_id: String,
    name: String,
    url: String,
    created_by: String,
    created_at: i64,
}

impl From<EmojiRow> for ServerEmoji {
    fn from(r: EmojiRow) -> Self {
        Self {
            id: r.id,
            server_id: r.server_id,
            name: r.name,
            url: r.url,
            created_by: r.created_by,
            created_at: r.created_at,
        }
    }
}

#[derive(Deserialize)]
pub struct CreateEmojiBody {
    pub name: String,
    pub file_id: String,
}

pub async fn list_emojis(
    _auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<ServerEmoji>>, (StatusCode, String)> {
    let rows: Vec<EmojiRow> = sqlx::query_as(
        "SELECT id, server_id, name, url, created_by, created_at
         FROM server_emojis WHERE server_id = ? ORDER BY name",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn create_emoji(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateEmojiBody>,
) -> Result<Json<ServerEmoji>, (StatusCode, String)> {
    // Validate emoji name: alphanumeric + underscores, 2–32 chars
    let name = body.name.trim().to_lowercase();
    if name.len() < 2 || name.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Emoji name must be 2–32 chars".into(),
        ));
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err((
            StatusCode::BAD_REQUEST,
            "Emoji name: letters, numbers, underscores only".into(),
        ));
    }

    // Check caller is in the server
    let is_member: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(&server_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if is_member.is_none() {
        return Err((StatusCode::FORBIDDEN, "Not a member of this server".into()));
    }

    // Resolve file URL
    let file_url: Option<(String,)> = sqlx::query_as("SELECT path FROM files WHERE id = ?")
        .bind(&body.file_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _path = file_url.ok_or_else(|| (StatusCode::NOT_FOUND, "File not found".into()))?;
    let url = format!("/files/{}", body.file_id);

    let id = new_id();
    let now = now_unix();

    sqlx::query(
        "INSERT INTO server_emojis (id, server_id, name, file_id, url, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&name)
    .bind(&body.file_id)
    .bind(&url)
    .bind(&auth.0)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            (
                StatusCode::CONFLICT,
                format!("Emoji :{name}: already exists"),
            )
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    })?;

    Ok(Json(ServerEmoji {
        id,
        server_id,
        name,
        url,
        created_by: auth.0,
        created_at: now,
    }))
}

pub async fn delete_emoji(
    auth: AuthUser,
    Path((server_id, emoji_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Only server member who created it (or in a real app, admin) can delete
    let row: Option<(String,)> =
        sqlx::query_as("SELECT created_by FROM server_emojis WHERE id = ? AND server_id = ?")
            .bind(&emoji_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (creator,) = row.ok_or_else(|| (StatusCode::NOT_FOUND, "Emoji not found".into()))?;
    if creator != auth.0 {
        return Err((
            StatusCode::FORBIDDEN,
            "Only the creator can delete this emoji".into(),
        ));
    }

    sqlx::query("DELETE FROM server_emojis WHERE id = ?")
        .bind(&emoji_id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}
