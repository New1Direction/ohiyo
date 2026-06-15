use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{create_token, hash_password, jwt_secret, verify_password},
    types::{new_id, now_unix, PublicUser, User},
    AppState,
};

/// Per-IP cap on auth attempts to blunt brute-forcing. Generous enough for
/// shared NATs and legit retries; still throttles online password guessing.
/// NOTE: behind a reverse proxy, parse X-Forwarded-For for the real client IP.
const AUTH_MAX_PER_MIN: usize = 40;

/// Resolve the real client IP for rate-limiting. Behind our deploy proxy (Fly),
/// the socket peer is the proxy — so prefer the proxy-set header. These headers
/// are only trustworthy behind a proxy that overwrites them (Fly does).
fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
    headers
        .get("fly-client-ip")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.split(',').next())
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| addr.ip().to_string())
}

fn check_auth_rate(state: &AppState, client_ip: &str) -> Result<(), (StatusCode, String)> {
    let key = format!("auth:{}", client_ip);
    if !state
        .rate
        .check(&key, AUTH_MAX_PER_MIN, Duration::from_secs(60))
    {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment and try again".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct RegisterBody {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: PublicUser,
}

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    check_auth_rate(&state, &client_ip(&headers, &addr))?;
    if body.username.len() < 2 || body.username.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            "username must be 2–32 chars".into(),
        ));
    }
    if body.password.len() < 8 {
        return Err((StatusCode::BAD_REQUEST, "password must be ≥8 chars".into()));
    }

    let existing: Option<User> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if existing.is_some() {
        return Err((StatusCode::CONFLICT, "username taken".into()));
    }

    let hash = hash_password(&body.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let id = new_id();
    let display_name = body.display_name.unwrap_or_else(|| body.username.clone());

    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&body.username)
    .bind(&display_name)
    .bind(&hash)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let user = User {
        id: id.clone(),
        username: body.username,
        display_name,
        password_hash: hash,
        avatar_url: None,
        created_at: now_unix(),
    };

    let secret = jwt_secret();
    let token = create_token(&id, &secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    check_auth_rate(&state, &client_ip(&headers, &addr))?;
    let user: Option<User> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let user = user.ok_or((StatusCode::UNAUTHORIZED, "invalid credentials".into()))?;

    if !verify_password(&body.password, &user.password_hash) {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    }

    let secret = jwt_secret();
    let token = create_token(&user.id, &secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}
