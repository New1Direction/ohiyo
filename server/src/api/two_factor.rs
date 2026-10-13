//! Two-factor sign-in: turning it on and off, recovery codes, the code step of signing in,
//! and the code check other actions ask for while it's on (`require_second_factor`).
//! The crypto (TOTP, the encrypted secret, recovery code hashes) is in `auth::two_factor`.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    api::auth::{check_auth_rate, current_token_version, require_password, AuthResponse},
    auth::{create_token, jwt_secret, two_factor as tf, AuthUser},
    gateway::broadcast_to_user,
    types::{now_unix, GatewayEvent, User},
    AppState,
};

type ApiError = (StatusCode, String);

/// Codes an account may try a minute, wherever they're typed (signing in, turning it on,
/// the actions that ask for one). Each wrong guess is one in a million; five a minute keeps
/// guessing hopeless.
const CODE_TRIES_PER_MIN: usize = 5;
/// Turning it on or off and asking for new recovery codes, per account a minute.
const CHANGES_PER_MIN: usize = 10;
/// How long a sign-in that got the password right has to give a code.
pub const CHALLENGE_TTL_SECS: i64 = 300;
/// Wrong codes a challenge takes before it's given up and the password is needed again.
const CHALLENGE_MAX_FAILURES: i64 = 10;
/// The name an authenticator app shows next to the code.
const ISSUER: &str = "Ohiyo";

/// The words the app matches on (lib/twoFactor.ts), so keep them.
const NEEDS_CODE: &str = "enter the code from your authenticator app";
const WRONG_CODE: &str = "that code isn't right";
const UNAVAILABLE: &str = "two-factor sign-in isn't available on this server";

fn too_many() -> ApiError {
    (
        StatusCode::TOO_MANY_REQUESTS,
        "too many attempts — give it a moment and try again".into(),
    )
}

fn sha256_hex(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn code_try(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.rate.check(
        &format!("two-factor-code:{user_id}"),
        CODE_TRIES_PER_MIN,
        Duration::from_secs(60),
    ) {
        Ok(())
    } else {
        Err(too_many())
    }
}

fn change_try(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.rate.check(
        &format!("two-factor-change:{user_id}"),
        CHANGES_PER_MIN,
        Duration::from_secs(60),
    ) {
        Ok(())
    } else {
        Err(too_many())
    }
}

/// Whether the account has two-factor sign-in on (not just being set up).
pub async fn is_enabled(state: &AppState, user_id: &str) -> Result<bool, ApiError> {
    let on: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM two_factor WHERE user_id = ? AND enabled_at IS NOT NULL")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    Ok(on.is_some())
}

/// Check a typed code — six digits from the app, or a recovery code — and use it up.
/// `Ok(false)` when it's wrong.
async fn use_code(state: &AppState, user_id: &str, typed: &str) -> Result<bool, ApiError> {
    if let Some(normalized) = tf::normalize_recovery_code(typed) {
        let hash = tf::hash_recovery_code(user_id, &normalized);
        let used = sqlx::query(
            "UPDATE two_factor_recovery_codes SET used_at = ?
             WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        )
        .bind(now_unix())
        .bind(user_id)
        .bind(&hash)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
        return Ok(used.rows_affected() == 1);
    }
    let row: Option<(Vec<u8>, i64)> = sqlx::query_as(
        "SELECT secret_enc, last_step FROM two_factor WHERE user_id = ? AND enabled_at IS NOT NULL",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let Some((sealed, last_step)) = row else {
        return Ok(false);
    };
    let Some(secret_box) = &state.two_factor else {
        // The key went away after this account turned it on: its codes can't be checked,
        // but its recovery codes (above) still work.
        tracing::warn!("a two-factor code arrived but the server has no key to check it");
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            format!("{UNAVAILABLE} right now — use a recovery code"),
        ));
    };
    let Some(secret) = secret_box.open(user_id, &sealed) else {
        tracing::warn!("a two-factor secret didn't open with this server's key");
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            format!("{UNAVAILABLE} right now — use a recovery code"),
        ));
    };
    let Some(step) = tf::verify_code(&secret, typed, now_unix(), last_step) else {
        return Ok(false);
    };
    // Moved forward only if nothing newer was used meanwhile, so two requests with the same
    // code can't both get in.
    let moved =
        sqlx::query("UPDATE two_factor SET last_step = ? WHERE user_id = ? AND last_step < ?")
            .bind(step)
            .bind(user_id)
            .bind(step)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    Ok(moved.rows_affected() == 1)
}

/// For actions a stolen session plus a stolen password mustn't be enough for while two-factor
/// sign-in is on (changing the password, deleting the account, turning it off, new recovery
/// codes): a code too. Nothing to do when it's off. 403 when the code is missing or wrong.
pub(crate) async fn require_second_factor(
    state: &AppState,
    user_id: &str,
    code: Option<String>,
) -> Result<(), ApiError> {
    if !is_enabled(state, user_id).await? {
        return Ok(());
    }
    let Some(code) = code.filter(|c| !c.trim().is_empty()) else {
        return Err((StatusCode::FORBIDDEN, NEEDS_CODE.into()));
    };
    code_try(state, user_id)?;
    if use_code(state, user_id, &code).await? {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, WRONG_CODE.into()))
    }
}

/// Make and store fresh recovery codes, replacing any old ones, inside `tx`.
async fn replace_recovery_codes(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
) -> Result<Vec<String>, ApiError> {
    sqlx::query("DELETE FROM two_factor_recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(crate::api::error::internal)?;
    let codes = tf::generate_recovery_codes();
    for code in &codes {
        let normalized = tf::normalize_recovery_code(code).expect("a generated code reads back");
        sqlx::query("INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES (?, ?)")
            .bind(user_id)
            .bind(tf::hash_recovery_code(user_id, &normalized))
            .execute(&mut **tx)
            .await
            .map_err(crate::api::error::internal)?;
    }
    Ok(codes)
}

fn announce(state: &AppState, user_id: &str, enabled: bool) {
    broadcast_to_user(
        &state.sessions,
        user_id,
        &GatewayEvent::TwoFactorUpdate { enabled },
    );
}

// ── Settings ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Status {
    pub enabled: bool,
    /// False when the server has no key to keep secrets with: it can't be turned on.
    pub available: bool,
    pub recovery_codes_left: i64,
}

/// GET /users/@me/two-factor
pub async fn status(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Status>, ApiError> {
    let enabled = is_enabled(&state, &auth.0).await?;
    let left: i64 = if enabled {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM two_factor_recovery_codes WHERE user_id = ? AND used_at IS NULL",
        )
        .bind(&auth.0)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?
    } else {
        0
    };
    Ok(Json(Status {
        enabled,
        available: state.two_factor.is_some(),
        recovery_codes_left: left,
    }))
}

#[derive(Deserialize)]
pub struct PasswordOnly {
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Serialize)]
pub struct SetupResponse {
    /// For typing into an app that can't scan; shown only now.
    pub secret: String,
    pub otpauth_url: String,
}

/// POST /users/@me/two-factor/setup — start turning it on. Needs the password, so a stolen
/// session can't put a code in front of the owner. Nothing changes for signing in until a
/// working code is sent to `enable`.
pub async fn setup(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<PasswordOnly>,
) -> Result<Json<SetupResponse>, ApiError> {
    let Some(secret_box) = state.two_factor.clone() else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE.into()));
    };
    change_try(&state, &auth.0)?;
    require_password(&state, &auth.0, body.password).await?;
    if is_enabled(&state, &auth.0).await? {
        return Err((
            StatusCode::CONFLICT,
            "two-factor sign-in is already on".into(),
        ));
    }
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&auth.0)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?
        .ok_or((StatusCode::UNAUTHORIZED, "invalid session".into()))?;
    let secret = tf::generate_secret();
    sqlx::query(
        "INSERT INTO two_factor (user_id, secret_enc, enabled_at, last_step, created_at)
         VALUES (?, ?, NULL, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled_at = NULL,
             last_step = 0, created_at = excluded.created_at",
    )
    .bind(&auth.0)
    .bind(secret_box.seal(&auth.0, &secret))
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(SetupResponse {
        secret: tf::base32_encode(&secret),
        otpauth_url: tf::otpauth_url(&secret, &user.username, ISSUER),
    }))
}

#[derive(Deserialize)]
pub struct CodeOnly {
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct RecoveryCodes {
    /// Shown once; only their hashes are kept.
    pub recovery_codes: Vec<String>,
}

/// POST /users/@me/two-factor/enable — finish turning it on with a working code. Answers
/// with the recovery codes, shown this once.
pub async fn enable(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CodeOnly>,
) -> Result<Json<RecoveryCodes>, ApiError> {
    let Some(secret_box) = state.two_factor.clone() else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE.into()));
    };
    code_try(&state, &auth.0)?;
    let pending: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT secret_enc FROM two_factor WHERE user_id = ? AND enabled_at IS NULL",
    )
    .bind(&auth.0)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let Some(sealed) = pending else {
        return Err((
            StatusCode::CONFLICT,
            "start setting up two-factor sign-in first".into(),
        ));
    };
    let secret = secret_box
        .open(&auth.0, &sealed)
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE.into()))?;
    let code = body.code.unwrap_or_default();
    let Some(step) = tf::verify_code(&secret, &code, now_unix(), 0) else {
        return Err((StatusCode::FORBIDDEN, WRONG_CODE.into()));
    };

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    let turned_on = sqlx::query(
        "UPDATE two_factor SET enabled_at = ?, last_step = ? WHERE user_id = ? AND enabled_at IS NULL",
    )
    .bind(now_unix())
    .bind(step)
    .bind(&auth.0)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    if turned_on.rows_affected() != 1 {
        return Err((
            StatusCode::CONFLICT,
            "two-factor sign-in is already on".into(),
        ));
    }
    let codes = replace_recovery_codes(&mut tx, &auth.0).await?;
    tx.commit().await.map_err(crate::api::error::internal)?;
    tracing::info!(user_id = %auth.0, "two-factor sign-in turned on");
    announce(&state, &auth.0, true);
    Ok(Json(RecoveryCodes {
        recovery_codes: codes,
    }))
}

#[derive(Deserialize)]
pub struct PasswordAndCode {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

async fn require_on(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if is_enabled(state, user_id).await? {
        Ok(())
    } else {
        Err((StatusCode::CONFLICT, "two-factor sign-in is off".into()))
    }
}

/// POST /users/@me/two-factor/disable — turn it off. Needs the password and a code.
pub async fn disable(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<PasswordAndCode>,
) -> Result<StatusCode, ApiError> {
    change_try(&state, &auth.0)?;
    require_password(&state, &auth.0, body.password).await?;
    require_on(&state, &auth.0).await?;
    require_second_factor(&state, &auth.0, body.code).await?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    for sql in [
        "DELETE FROM two_factor WHERE user_id = ?",
        "DELETE FROM two_factor_recovery_codes WHERE user_id = ?",
        "DELETE FROM two_factor_challenges WHERE user_id = ?",
    ] {
        sqlx::query(sql)
            .bind(&auth.0)
            .execute(&mut *tx)
            .await
            .map_err(crate::api::error::internal)?;
    }
    tx.commit().await.map_err(crate::api::error::internal)?;
    tracing::info!(user_id = %auth.0, "two-factor sign-in turned off");
    announce(&state, &auth.0, false);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /users/@me/two-factor/recovery-codes — new recovery codes; the old ones stop working.
/// Needs the password and a code.
pub async fn new_recovery_codes(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<PasswordAndCode>,
) -> Result<Json<RecoveryCodes>, ApiError> {
    change_try(&state, &auth.0)?;
    require_password(&state, &auth.0, body.password).await?;
    require_on(&state, &auth.0).await?;
    require_second_factor(&state, &auth.0, body.code).await?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    let codes = replace_recovery_codes(&mut tx, &auth.0).await?;
    tx.commit().await.map_err(crate::api::error::internal)?;
    Ok(Json(RecoveryCodes {
        recovery_codes: codes,
    }))
}

// ── Signing in ──────────────────────────────────────────────────────────────────

/// What the password step of signing in answers when two-factor sign-in is on: no session
/// yet, a challenge to answer with a code.
#[derive(Serialize)]
pub struct Challenge {
    pub two_factor_required: bool,
    pub challenge: String,
    pub expires_in: i64,
}

/// Start the code step for an account whose password was just right.
pub async fn start_challenge(state: &AppState, user_id: &str) -> Result<Challenge, ApiError> {
    let now = now_unix();
    sqlx::query("DELETE FROM two_factor_challenges WHERE expires_at < ?")
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    sqlx::query(
        "INSERT INTO two_factor_challenges (token_hash, user_id, expires_at, failures) VALUES (?, ?, ?, 0)",
    )
    .bind(sha256_hex(token.as_bytes()))
    .bind(user_id)
    .bind(now + CHALLENGE_TTL_SECS)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Challenge {
        two_factor_required: true,
        challenge: token,
        expires_in: CHALLENGE_TTL_SECS,
    })
}

#[derive(Deserialize)]
pub struct CodeStep {
    pub challenge: String,
    pub code: String,
}

/// POST /auth/login/two-factor — the code step of signing in. A right code (or recovery
/// code) turns the challenge into a session; the challenge works once.
pub async fn login_code(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CodeStep>,
) -> Result<Json<AuthResponse>, ApiError> {
    check_auth_rate(&state, &headers, &addr)?;
    let hash = sha256_hex(body.challenge.as_bytes());
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT user_id, expires_at FROM two_factor_challenges WHERE token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let gone = || {
        (
            StatusCode::UNAUTHORIZED,
            "sign in again — that took too long".to_owned(),
        )
    };
    let Some((user_id, expires_at)) = row else {
        return Err(gone());
    };
    if expires_at < now_unix() {
        sqlx::query("DELETE FROM two_factor_challenges WHERE token_hash = ?")
            .bind(&hash)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
        return Err(gone());
    }
    code_try(&state, &user_id)?;
    if !use_code(&state, &user_id, &body.code).await? {
        // None when another request used or gave up the challenge meanwhile.
        let failures: Option<i64> = sqlx::query_scalar(
            "UPDATE two_factor_challenges SET failures = failures + 1 WHERE token_hash = ? RETURNING failures",
        )
        .bind(&hash)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
        let Some(failures) = failures else {
            return Err(gone());
        };
        if failures >= CHALLENGE_MAX_FAILURES {
            sqlx::query("DELETE FROM two_factor_challenges WHERE token_hash = ?")
                .bind(&hash)
                .execute(&state.db)
                .await
                .map_err(crate::api::error::internal)?;
        }
        return Err((StatusCode::FORBIDDEN, WRONG_CODE.into()));
    }
    // One use: whoever gets here first takes it.
    let taken = sqlx::query("DELETE FROM two_factor_challenges WHERE token_hash = ?")
        .bind(&hash)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if taken.rows_affected() != 1 {
        return Err(gone());
    }
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?
        .ok_or_else(gone)?;
    let token_version = current_token_version(&state, &user.id).await?;
    let token = create_token(&user.id, token_version, &jwt_secret())
        .map_err(crate::api::error::internal)?;
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}
