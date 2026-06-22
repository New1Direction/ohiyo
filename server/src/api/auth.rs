use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{create_token, hash_password, jwt_secret, verify_password, AuthUser},
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
        .map_err(crate::api::error::internal)?;

    if existing.is_some() {
        return Err((StatusCode::CONFLICT, "username taken".into()));
    }

    let hash = hash_password(&body.password).map_err(crate::api::error::internal)?;

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
    .map_err(crate::api::error::internal)?;

    let user = User {
        id: id.clone(),
        username: body.username,
        display_name,
        password_hash: hash,
        avatar_url: None,
        created_at: now_unix(),
    };

    let secret = jwt_secret();
    // A freshly created user starts at token_version 0 (the column default).
    let token = create_token(&id, 0, &secret).map_err(crate::api::error::internal)?;

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
        .map_err(crate::api::error::internal)?;

    let user = user.ok_or((StatusCode::UNAUTHORIZED, "invalid credentials".into()))?;

    if !verify_password(&body.password, &user.password_hash) {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    }

    let secret = jwt_secret();
    let token_version = current_token_version(&state, &user.id).await;
    let token =
        create_token(&user.id, token_version, &secret).map_err(crate::api::error::internal)?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

/// Read a user's current token generation counter. Missing/error → 0 (the column
/// default), which is the safe baseline for a token that carries no explicit version.
async fn current_token_version(state: &AppState, user_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT token_version FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// POST /auth/logout-everywhere — bump the user's token_version, invalidating every
/// JWT minted before now. The client should discard its token and re-authenticate.
/// (Also the hook a future password-change endpoint calls to force re-login.)
pub async fn logout_everywhere(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = ?")
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Device linking (QR / one-time code) ─────────────────────────────────────────
const LINK_TTL_SECS: i64 = 120;
const LINK_MAX_PER_MIN: usize = 20;

/// A one-time link code: 12 chars from a 31-char unambiguous alphabet (~59 bits, via the
/// OS-seeded ChaCha CSPRNG). With the 2-minute TTL, single use, and per-IP rate limit on
/// redeem, it can't be brute-forced.
fn gen_link_code() -> String {
    use rand::Rng;
    const ALPHA: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

/// Periodic GC: drop expired device-link codes so the table can't grow unbounded.
pub async fn sweep_link_tokens(state: &AppState) {
    let _ = sqlx::query("DELETE FROM device_link_tokens WHERE expires_at < ?")
        .bind(now_unix())
        .execute(&state.db)
        .await;
}

#[derive(Serialize)]
pub struct LinkStartResponse {
    pub code: String,
    pub expires_at: i64,
}

/// POST /devices/link/start — (auth) mint a short-lived one-time code that links a NEW
/// device to THIS account without re-entering the password. Shown as text + QR on the
/// primary device; the new device redeems it at /devices/link/complete.
pub async fn link_start(
    auth: crate::auth::AuthUser,
    State(state): State<AppState>,
) -> Result<Json<LinkStartResponse>, (StatusCode, String)> {
    // One active code per user: clear any previous ones first (caps the table per user
    // and means a fresh request supersedes an unused old code).
    sqlx::query("DELETE FROM device_link_tokens WHERE user_id = ?")
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "db error clearing link codes");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
        })?;
    let code = gen_link_code();
    let expires_at = now_unix() + LINK_TTL_SECS;
    sqlx::query("INSERT INTO device_link_tokens (code, user_id, expires_at) VALUES (?,?,?)")
        .bind(&code)
        .bind(&auth.0)
        .bind(expires_at)
        .execute(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "db error minting link code");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
        })?;
    Ok(Json(LinkStartResponse { code, expires_at }))
}

#[derive(Deserialize)]
pub struct LinkCompleteBody {
    pub code: String,
}

/// POST /devices/link/complete — (no auth) redeem a link code from a new device and get a
/// session token for the linked account. Single-use (atomically claimed) + short TTL +
/// per-IP rate-limited so the code can't be brute-forced.
pub async fn link_complete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LinkCompleteBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    let ip = client_ip(&headers, &addr);
    if !state.rate.check(
        &format!("link:{}", ip),
        LINK_MAX_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment".into(),
        ));
    }
    // Normalize: strip grouping/whitespace, uppercase.
    let code: String = body
        .code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if code.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing code".into()));
    }
    // Atomically claim the code (delete + return its row) so it can't be redeemed twice.
    let row: Option<(String, i64)> = sqlx::query_as(
        "DELETE FROM device_link_tokens WHERE code = ? RETURNING user_id, expires_at",
    )
    .bind(&code)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "db error redeeming link code");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error".to_owned(),
        )
    })?;
    // Same response whether the code never existed, was already used, or expired (it's
    // consumed either way) — so the endpoint isn't an oracle for which codes existed.
    let invalid = || (StatusCode::NOT_FOUND, "invalid or expired code".to_owned());
    let (user_id, expires_at) = row.ok_or_else(invalid)?;
    if expires_at < now_unix() {
        return Err(invalid());
    }
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|_| invalid())?;
    let secret = jwt_secret();
    let token_version = current_token_version(&state, &user.id).await;
    let token = create_token(&user.id, token_version, &secret).map_err(|e| {
        tracing::error!(error = %e, "token error in link_complete");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error".to_owned(),
        )
    })?;
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}
