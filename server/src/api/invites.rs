use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::{
    api::servers::fetch_full_for_user,
    auth::AuthUser,
    gateway::broadcast_to_server,
    types::{now_unix, GatewayEvent, Invite, PublicUser, Server, ServerWithChannels, User},
    AppState,
};

// Unambiguous code alphabet — no 0/O/1/l/I to keep links easy to read aloud.
const CODE_CHARS: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN: usize = 8;

/// Per-user invite create/redeem throttle: 20 per minute (generous for humans,
/// blunts code churn and brute-force redemption).
const INVITE_RATE_MAX: usize = 20;
const INVITE_RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

fn gen_code() -> String {
    let mut rng = rand::thread_rng();
    (0..CODE_LEN)
        .map(|_| CODE_CHARS[rng.gen_range(0..CODE_CHARS.len())] as char)
        .collect()
}

async fn is_member(
    state: &AppState,
    server_id: &str,
    user_id: &str,
) -> Result<bool, (StatusCode, String)> {
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    Ok(found.is_some())
}

/// An invite is dead if it has expired or exhausted its uses.
fn invite_alive(inv: &Invite, now: i64) -> bool {
    if let Some(exp) = inv.expires_at {
        if exp <= now {
            return false;
        }
    }
    if let Some(max) = inv.max_uses {
        if inv.uses >= max {
            return false;
        }
    }
    true
}

#[derive(Deserialize, Default)]
pub struct CreateInviteBody {
    pub max_uses: Option<i64>,
    pub expires_in_secs: Option<i64>,
}

#[derive(Serialize)]
pub struct InviteInfo {
    pub code: String,
    pub server_id: String,
    pub expires_at: Option<i64>,
    pub max_uses: Option<i64>,
    pub uses: i64,
}

/// POST /servers/{id}/invites — members can mint a shareable join code.
pub async fn create_invite(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateInviteBody>,
) -> Result<Json<InviteInfo>, (StatusCode, String)> {
    // Cap invite creation so a single account can't churn out codes.
    if !state.rate.check(
        &format!("invite-create:{}", auth.0),
        INVITE_RATE_MAX,
        INVITE_RATE_WINDOW,
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're creating invites too fast".into(),
        ));
    }
    if !is_member(&state, &server_id, &auth.0).await? {
        return Err((
            StatusCode::FORBIDDEN,
            "join the server before inviting others".into(),
        ));
    }

    let now = now_unix();
    // Clamp to sane bounds so `now + ttl` can't overflow and codes stay usable.
    const MAX_TTL_SECS: i64 = 60 * 60 * 24 * 30; // 30 days
    const MAX_USES_CAP: i64 = 100_000;
    let expires_at = body
        .expires_in_secs
        .filter(|s| *s > 0)
        .map(|s| now + s.min(MAX_TTL_SECS));
    let max_uses = body
        .max_uses
        .filter(|m| *m > 0)
        .map(|m| m.min(MAX_USES_CAP));

    // Land newcomers in the server's first text channel.
    let channel_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM channels WHERE server_id = ? AND channel_type = 'text' ORDER BY position LIMIT 1",
    )
    .bind(&server_id)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    // Retry on the (vanishingly rare) code collision.
    for _ in 0..6 {
        let code = gen_code();
        let res = sqlx::query(
            "INSERT INTO invites (code, server_id, channel_id, created_by, created_at, expires_at, max_uses, uses)
             VALUES (?,?,?,?,?,?,?,0)",
        )
        .bind(&code)
        .bind(&server_id)
        .bind(&channel_id)
        .bind(&auth.0)
        .bind(now)
        .bind(expires_at)
        .bind(max_uses)
        .execute(&state.db)
        .await;

        match res {
            Ok(_) => {
                return Ok(Json(InviteInfo {
                    code,
                    server_id,
                    expires_at,
                    max_uses,
                    uses: 0,
                }))
            }
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(crate::api::error::internal(e)),
        }
    }
    Err((
        StatusCode::INTERNAL_SERVER_ERROR,
        "couldn't allocate an invite code".into(),
    ))
}

#[derive(Serialize)]
pub struct InvitePreview {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    pub icon_url: Option<String>,
    pub member_count: i64,
    pub already_member: bool,
}

/// GET /invites/{code} — preview a server before joining (no side effects).
/// Any authenticated holder of a valid code can see the server's name + member
/// count. That's intentional: possessing the code is the access gate (same model
/// as other chat platforms). Codes are unguessable and revocable.
pub async fn get_invite(
    auth: AuthUser,
    Path(code): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<InvitePreview>, (StatusCode, String)> {
    let inv = lookup_alive_invite(&state, &code).await?;

    let server: Server = sqlx::query_as("SELECT * FROM servers WHERE id = ?")
        .bind(&inv.server_id)
        .fetch_one(&state.db)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "that server no longer exists".into()))?;

    let member_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM server_members WHERE server_id = ?")
            .bind(&inv.server_id)
            .fetch_one(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    Ok(Json(InvitePreview {
        code: inv.code,
        server_id: inv.server_id.clone(),
        server_name: server.name,
        icon_url: server.icon_url,
        member_count,
        already_member: is_member(&state, &inv.server_id, &auth.0).await?,
    }))
}

/// POST /invites/{code} — redeem an invite and join the server.
pub async fn redeem_invite(
    auth: AuthUser,
    Path(code): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<ServerWithChannels>, (StatusCode, String)> {
    // Cap redemption attempts so codes can't be brute-forced / churned by one account.
    if !state.rate.check(
        &format!("invite-redeem:{}", auth.0),
        INVITE_RATE_MAX,
        INVITE_RATE_WINDOW,
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're redeeming invites too fast".into(),
        ));
    }
    let inv = lookup_alive_invite(&state, &code).await?;

    if crate::api::servers::is_banned(&state, &inv.server_id, &auth.0).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you're banned from this server".into(),
        ));
    }

    let now = now_unix();

    let result = sqlx::query(
        "INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)",
    )
    .bind(&inv.server_id)
    .bind(&auth.0)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    // Only count + announce a genuinely new membership.
    if result.rows_affected() > 0 {
        // Conditional bump so the counter never visibly exceeds max_uses. A true
        // concurrent race on the final slot can still admit one extra member
        // (membership is inserted above) — an accepted tradeoff for a social app.
        sqlx::query(
            "UPDATE invites SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)",
        )
        .bind(&code)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

        let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
            .bind(&auth.0)
            .fetch_one(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

        broadcast_to_server(
            &state,
            &inv.server_id,
            &GatewayEvent::MemberJoin {
                server_id: inv.server_id.clone(),
                user: PublicUser::from(user),
            },
        )
        .await;
    }

    Ok(Json(
        fetch_full_for_user(&inv.server_id, &state, &auth.0).await?,
    ))
}

/// DELETE /invites/{code} — the creator or server owner can revoke a code.
pub async fn revoke_invite(
    auth: AuthUser,
    Path(code): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let inv: Option<Invite> = sqlx::query_as("SELECT * FROM invites WHERE code = ?")
        .bind(&code)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let inv = inv.ok_or((StatusCode::NOT_FOUND, "invite not found".into()))?;

    let owner_id: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(&inv.server_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let is_owner = owner_id.as_deref() == Some(auth.0.as_str());
    if inv.created_by != auth.0 && !is_owner {
        return Err((
            StatusCode::FORBIDDEN,
            "only the creator or owner can revoke this".into(),
        ));
    }

    sqlx::query("DELETE FROM invites WHERE code = ?")
        .bind(&code)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// Fetch an invite and reject it if missing or dead. Uses a generic "expired"
/// message for dead codes so we don't leak whether a code ever existed.
async fn lookup_alive_invite(state: &AppState, code: &str) -> Result<Invite, (StatusCode, String)> {
    let inv: Option<Invite> = sqlx::query_as("SELECT * FROM invites WHERE code = ?")
        .bind(code)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let inv = inv.ok_or((
        StatusCode::NOT_FOUND,
        "this invite link is invalid or has expired".into(),
    ))?;

    if !invite_alive(&inv, now_unix()) {
        return Err((
            StatusCode::GONE,
            "this invite link is invalid or has expired".into(),
        ));
    }
    Ok(inv)
}
