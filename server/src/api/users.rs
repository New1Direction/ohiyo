use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix, Channel, PublicUser, User},
    AppState,
};

#[derive(Deserialize)]
pub struct UserSearchQuery {
    pub q: String,
}

/// GET /users/search?q=… — find people to DM by username or display name.
pub async fn search_users(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<UserSearchQuery>,
) -> Result<Json<Vec<PublicUser>>, (StatusCode, String)> {
    let term = query.q.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    // Escape LIKE metacharacters so input matches literally (usernames may contain
    // '_'), then search with an explicit ESCAPE clause.
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let prefix = format!("{escaped}%");

    let users: Vec<User> = sqlx::query_as(
        "SELECT * FROM users
         WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') AND id != ?
         ORDER BY
           CASE WHEN username = ? THEN 0 WHEN username LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
           length(username)
         LIMIT 20",
    )
    .bind(&pattern)
    .bind(&pattern)
    .bind(&auth.0)
    .bind(term)
    .bind(&prefix)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(users.into_iter().map(PublicUser::from).collect()))
}

pub async fn me(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<PublicUser>, (StatusCode, String)> {
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&auth.0)
        .fetch_one(&state.db)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "user not found".into()))?;

    Ok(Json(user.into()))
}

pub async fn list_dms(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<Channel>>, (StatusCode, String)> {
    let dms: Vec<Channel> = sqlx::query_as(
        "SELECT c.* FROM channels c
         JOIN dm_participants dp ON dp.channel_id = c.id
         WHERE dp.user_id = ?
         ORDER BY c.created_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(dms))
}

#[derive(Deserialize)]
pub struct OpenDmBody {
    pub recipient_id: String,
}

pub async fn open_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<OpenDmBody>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    // Check if a DM already exists between these two users.
    let existing: Option<Channel> = sqlx::query_as(
        "SELECT c.* FROM channels c
         JOIN dm_participants dp1 ON dp1.channel_id = c.id AND dp1.user_id = ?
         JOIN dm_participants dp2 ON dp2.channel_id = c.id AND dp2.user_id = ?
         WHERE c.channel_type = 'dm'
         LIMIT 1",
    )
    .bind(&auth.0)
    .bind(&body.recipient_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(ch) = existing {
        return Ok(Json(ch));
    }

    let id = new_id();
    let now = now_unix();

    sqlx::query(
        "INSERT INTO channels (id, name, channel_type, position, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind("dm")
    .bind("dm")
    .bind(0i64)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for uid in [&auth.0, &body.recipient_id] {
        sqlx::query("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)")
            .bind(&id)
            .bind(uid)
            .execute(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let channel = Channel {
        id,
        server_id: None,
        name: "dm".to_owned(),
        channel_type: "dm".to_owned(),
        position: 0,
        topic: None,
        created_at: now,
        category_id: None,
    };

    Ok(Json(channel))
}
