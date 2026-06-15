use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct SetAvatarBody {
    pub file_id: String,
}

pub async fn set_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SetAvatarBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM files WHERE id = ?")
        .bind(&body.file_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "File not found".into()));
    }

    // Configurable for production; defaults to the local dev server.
    let base =
        std::env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_owned());
    let avatar_url = format!("{base}/files/{}", body.file_id);
    sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ?")
        .bind(&avatar_url)
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

use crate::{auth::AuthUser, AppState};

#[derive(Deserialize)]
pub struct UpdateProfileBody {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub pronouns: Option<String>,
    pub banner_color: Option<String>,
    pub custom_status: Option<String>,
    pub social_spotify: Option<String>,
    pub social_github: Option<String>,
    pub social_twitter: Option<String>,
    pub social_steam: Option<String>,
    pub social_youtube: Option<String>,
    pub social_twitch: Option<String>,
}

#[derive(Serialize)]
pub struct ProfileResponse {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub bio: Option<String>,
    pub pronouns: Option<String>,
    pub banner_color: Option<String>,
    pub custom_status: Option<String>,
    pub avatar_url: Option<String>,
    /// Unix time of last activity (connect / message send) → "active Xm ago" / last seen.
    pub last_active_at: Option<i64>,
    pub social_spotify: Option<String>,
    pub social_github: Option<String>,
    pub social_twitter: Option<String>,
    pub social_steam: Option<String>,
    pub social_youtube: Option<String>,
    pub social_twitch: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ProfileRow {
    id: String,
    username: String,
    display_name: String,
    bio: Option<String>,
    pronouns: Option<String>,
    banner_color: Option<String>,
    custom_status: Option<String>,
    avatar_url: Option<String>,
    last_active_at: Option<i64>,
    social_spotify: Option<String>,
    social_github: Option<String>,
    social_twitter: Option<String>,
    social_steam: Option<String>,
    social_youtube: Option<String>,
    social_twitch: Option<String>,
}

impl From<ProfileRow> for ProfileResponse {
    fn from(r: ProfileRow) -> Self {
        Self {
            id: r.id,
            username: r.username,
            display_name: r.display_name,
            bio: r.bio,
            pronouns: r.pronouns,
            banner_color: r.banner_color,
            custom_status: r.custom_status,
            avatar_url: r.avatar_url,
            last_active_at: r.last_active_at,
            social_spotify: r.social_spotify,
            social_github: r.social_github,
            social_twitter: r.social_twitter,
            social_steam: r.social_steam,
            social_youtube: r.social_youtube,
            social_twitch: r.social_twitch,
        }
    }
}

pub async fn get_profile(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ProfileResponse>, (StatusCode, String)> {
    let row: ProfileRow = sqlx::query_as(
        "SELECT id, username, display_name, bio, pronouns, banner_color, custom_status,
                avatar_url, last_active_at, social_spotify, social_github, social_twitter, social_steam,
                social_youtube, social_twitch
         FROM users WHERE id = ?",
    )
    .bind(&auth.0)
    .fetch_one(&state.db)
    .await
    .map_err(|_| (StatusCode::NOT_FOUND, "user not found".into()))?;

    Ok(Json(row.into()))
}

pub async fn get_user_profile(
    _auth: AuthUser,
    axum::extract::Path(user_id): axum::extract::Path<String>,
    State(state): State<AppState>,
) -> Result<Json<ProfileResponse>, (StatusCode, String)> {
    let row: ProfileRow = sqlx::query_as(
        "SELECT id, username, display_name, bio, pronouns, banner_color, custom_status,
                avatar_url, last_active_at, social_spotify, social_github, social_twitter, social_steam,
                social_youtube, social_twitch
         FROM users WHERE id = ?",
    )
    .bind(&user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| (StatusCode::NOT_FOUND, "user not found".into()))?;

    Ok(Json(row.into()))
}

pub async fn update_profile(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UpdateProfileBody>,
) -> Result<Json<ProfileResponse>, (StatusCode, String)> {
    if let Some(name) = &body.display_name {
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
            .bind(name)
            .bind(&auth.0)
            .execute(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    macro_rules! update_field {
        ($field:ident) => {
            if let Some(val) = &body.$field {
                let col = stringify!($field);
                let sql = format!("UPDATE users SET {} = ? WHERE id = ?", col);
                sqlx::query(&sql)
                    .bind(val)
                    .bind(&auth.0)
                    .execute(&state.db)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            }
        };
    }

    update_field!(bio);
    update_field!(pronouns);
    update_field!(banner_color);
    update_field!(custom_status);
    update_field!(social_spotify);
    update_field!(social_github);
    update_field!(social_twitter);
    update_field!(social_steam);
    update_field!(social_youtube);
    update_field!(social_twitch);

    let row: ProfileRow = sqlx::query_as(
        "SELECT id, username, display_name, bio, pronouns, banner_color, custom_status,
                avatar_url, last_active_at, social_spotify, social_github, social_twitter, social_steam,
                social_youtube, social_twitch
         FROM users WHERE id = ?",
    )
    .bind(&auth.0)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(row.into()))
}

/// Get/set plugin preferences for the current user.
pub async fn get_prefs(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT prefs_json FROM user_prefs WHERE user_id = ?")
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let json: serde_json::Value = row
        .and_then(|(s,)| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));

    Ok(Json(json))
}

pub async fn set_prefs(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, (StatusCode, String)> {
    let json_str =
        serde_json::to_string(&body).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    sqlx::query(
        "INSERT INTO user_prefs (user_id, prefs_json) VALUES (?,?)
         ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json",
    )
    .bind(&auth.0)
    .bind(&json_str)
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// Encrypted E2E key-backup (recovery-code model). The body is opaque ciphertext
/// produced on the client; the server stores and returns it verbatim — it never
/// sees the recovery code or the key material.
pub async fn get_key_backup(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let row: Option<(String,)> = sqlx::query_as("SELECT blob FROM key_backups WHERE user_id = ?")
        .bind(&auth.0)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match row {
        Some((s,)) => {
            let v: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(Json(v))
        }
        None => Err((StatusCode::NOT_FOUND, "no backup".into())),
    }
}

pub async fn put_key_backup(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, (StatusCode, String)> {
    let blob =
        serde_json::to_string(&body).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    sqlx::query(
        "INSERT INTO key_backups (user_id, blob, updated_at) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(&auth.0)
    .bind(&blob)
    .bind(crate::types::now_unix())
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_key_backup(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM key_backups WHERE user_id = ?")
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}
