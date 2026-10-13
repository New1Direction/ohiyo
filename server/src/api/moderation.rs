//! Moderation a space can do without bots: time members out and slow a channel down.
//! Invite controls live in `invite_controls`, the ban list in `bans`.
//!
//! A time out is a row in `member_timeouts` whose `until` hasn't passed: the member can
//! still read, but can't post, react, start threads, make invites or join voice. Slowmode is
//! a per-channel minimum gap between one person's messages, claimed atomically in
//! `slowmode_marks` so two sends at once can't both slip through.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::{
    api::roles::{self, perm},
    auth::AuthUser,
    gateway::{broadcast_to_channel, broadcast_to_user},
    types::{now_unix, GatewayEvent},
    AppState,
};

type ApiError = (StatusCode, String);

/// The lengths a time out can take, as Discord offers them.
pub const TIMEOUT_SECONDS: [i64; 6] = [60, 300, 600, 3_600, 86_400, 604_800];
/// The gaps slowmode can enforce (0 turns it off).
pub const SLOWMODE_SECONDS: [i64; 8] = [0, 5, 10, 30, 60, 300, 900, 3_600];
/// Longest reason kept with a time out or a ban.
const MAX_REASON_CHARS: usize = 512;

/// The JSON body of a request, or the default when there is none. The app's request helper
/// always says the body is JSON, even when it sends nothing, and older apps ban with no
/// body at all, so an empty body has to mean "no options".
pub fn optional_json<T: DeserializeOwned + Default>(body: &Bytes) -> Result<T, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid body: {e}")))
}

pub(crate) fn clean_reason(reason: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(reason) = reason else {
        return Ok(None);
    };
    let reason = reason.trim();
    if reason.is_empty() {
        return Ok(None);
    }
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("keep the reason under {MAX_REASON_CHARS} characters"),
        ));
    }
    Ok(Some(reason.to_owned()))
}

// ── Time outs ─────────────────────────────────────────────────────────────────

/// When `user_id`'s time out in `server_id` ends, if they are timed out right now.
pub async fn active_timeout(state: &AppState, server_id: &str, user_id: &str) -> Option<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT until FROM member_timeouts WHERE server_id = ? AND user_id = ? AND until > ?",
    )
    .bind(server_id)
    .bind(user_id)
    .bind(now_unix())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
}

/// The time out that applies to `user_id` in the space `channel_id` belongs to (threads
/// included). None for a DM or group chat, which no space moderates.
pub async fn timeout_in_channel(state: &AppState, channel_id: &str, user_id: &str) -> Option<i64> {
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    active_timeout(state, server_id.as_deref()?, user_id).await
}

/// What a timed-out member hears when they try to post, react, start a thread, invite or
/// join voice.
pub fn timed_out_error() -> ApiError {
    (
        StatusCode::FORBIDDEN,
        "you're timed out in this space".into(),
    )
}

/// Refuse when `user_id` is timed out in the space `channel_id` belongs to.
pub async fn ensure_not_timed_out_in_channel(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<(), ApiError> {
    match timeout_in_channel(state, channel_id, user_id).await {
        Some(_) => Err(timed_out_error()),
        None => Ok(()),
    }
}

#[derive(Deserialize, Default)]
pub struct TimeoutBody {
    pub seconds: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct TimeoutInfo {
    pub user_id: String,
    pub until: i64,
    pub reason: Option<String>,
}

/// Who may act on whom: the actor needs `flag`, can't be timed out themselves, and must
/// outrank the target (the owner outranks everyone and can't be acted on). The target must
/// be a member.
async fn require_moderator_over(
    state: &AppState,
    server_id: &str,
    actor_id: &str,
    target_id: &str,
    flag: i64,
) -> Result<(), ApiError> {
    let owner_id: Option<String> = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let owner_id = owner_id.ok_or((StatusCode::NOT_FOUND, "space not found".into()))?;
    if target_id == owner_id {
        return Err((
            StatusCode::BAD_REQUEST,
            "the owner can't be timed out".into(),
        ));
    }
    let actor_permissions = roles::member_permissions(state, server_id, actor_id).await;
    if actor_permissions & (flag | perm::ADMINISTRATOR) == 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you don't have permission for that".into(),
        ));
    }
    if active_timeout(state, server_id, actor_id).await.is_some() {
        return Err(timed_out_error());
    }
    if !crate::api::servers::is_member(state, server_id, target_id).await {
        return Err((
            StatusCode::NOT_FOUND,
            "that person isn't in this space".into(),
        ));
    }
    let actor_rank = roles::member_top_position(state, server_id, actor_id).await;
    let target_rank = roles::member_top_position(state, server_id, target_id).await;
    if actor_rank <= target_rank {
        return Err((
            StatusCode::FORBIDDEN,
            "that member ranks too high for you to act on".into(),
        ));
    }
    if roles::member_permissions(state, server_id, target_id).await & perm::ADMINISTRATOR != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "administrators can't be timed out".into(),
        ));
    }
    Ok(())
}

/// PUT /servers/{server_id}/members/{user_id}/timeout — time a member out.
pub async fn set_timeout(
    auth: AuthUser,
    Path((server_id, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<TimeoutBody>,
) -> Result<Json<TimeoutInfo>, ApiError> {
    require_moderator_over(
        &state,
        &server_id,
        &auth.0,
        &target_id,
        perm::MODERATE_MEMBERS,
    )
    .await?;
    if !TIMEOUT_SECONDS.contains(&body.seconds) {
        return Err((
            StatusCode::BAD_REQUEST,
            "a time out lasts 60 seconds, 5 or 10 minutes, an hour, a day or a week".into(),
        ));
    }
    let reason = clean_reason(body.reason)?;
    let now = now_unix();
    let until = now + body.seconds;
    sqlx::query(
        "INSERT INTO member_timeouts (server_id, user_id, until, reason, actor_id, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(server_id, user_id) DO UPDATE SET
             until = excluded.until, reason = excluded.reason,
             actor_id = excluded.actor_id, created_at = excluded.created_at",
    )
    .bind(&server_id)
    .bind(&target_id)
    .bind(until)
    .bind(&reason)
    .bind(&auth.0)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let metadata = serde_json::json!({ "seconds": body.seconds, "until": until, "reason": reason })
        .to_string();
    crate::api::abuse::log_action(
        &state,
        crate::api::abuse::ActionLog {
            server_id: Some(&server_id),
            actor_id: &auth.0,
            action: "timeout_member",
            target_type: "user",
            target_id: &target_id,
            report_id: None,
            metadata: Some(&metadata),
        },
    )
    .await?;
    // Out of any call in the space, and their apps learn at once (permissions carry the
    // time out's end).
    crate::gateway::evict_from_server_voice(&state, &server_id, &target_id).await;
    broadcast_to_user(
        &state.sessions,
        &target_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    );
    Ok(Json(TimeoutInfo {
        user_id: target_id,
        until,
        reason,
    }))
}

/// DELETE /servers/{server_id}/members/{user_id}/timeout — lift a time out early.
pub async fn remove_timeout(
    auth: AuthUser,
    Path((server_id, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    require_moderator_over(
        &state,
        &server_id,
        &auth.0,
        &target_id,
        perm::MODERATE_MEMBERS,
    )
    .await?;
    let removed = sqlx::query("DELETE FROM member_timeouts WHERE server_id = ? AND user_id = ?")
        .bind(&server_id)
        .bind(&target_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if removed.rows_affected() > 0 {
        crate::api::abuse::log_action(
            &state,
            crate::api::abuse::ActionLog {
                server_id: Some(&server_id),
                actor_id: &auth.0,
                action: "remove_timeout",
                target_type: "user",
                target_id: &target_id,
                report_id: None,
                metadata: None,
            },
        )
        .await?;
    }
    broadcast_to_user(
        &state.sessions,
        &target_id,
        &GatewayEvent::PermissionsUpdate {
            server_id: server_id.clone(),
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// GET /servers/{server_id}/timeouts — the space's current time outs, for the people who
/// can hand them out (the member list shows them).
pub async fn list_timeouts(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<TimeoutInfo>>, ApiError> {
    let permissions = roles::member_permissions(&state, &server_id, &auth.0).await;
    if permissions & (perm::MODERATE_MEMBERS | perm::ADMINISTRATOR) == 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you don't have permission for that".into(),
        ));
    }
    let rows: Vec<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT user_id, until, reason FROM member_timeouts
         WHERE server_id = ? AND until > ? ORDER BY until",
    )
    .bind(&server_id)
    .bind(now_unix())
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(user_id, until, reason)| TimeoutInfo {
                user_id,
                until,
                reason,
            })
            .collect(),
    ))
}

// ── Slowmode ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SlowmodeBody {
    pub seconds: i64,
}

/// PUT /channels/{channel_id}/slowmode — set a space channel's slowmode (0 turns it off).
pub async fn set_slowmode(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<SlowmodeBody>,
) -> Result<StatusCode, ApiError> {
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?
            .flatten();
    let Some(server_id) = server_id else {
        return Err((StatusCode::NOT_FOUND, "channel not found".into()));
    };
    if !roles::has_channel_perm(&state, &channel_id, &auth.0, perm::MANAGE_CHANNELS).await {
        return Err((
            StatusCode::FORBIDDEN,
            "you can't change this channel".into(),
        ));
    }
    if !SLOWMODE_SECONDS.contains(&body.seconds) {
        return Err((
            StatusCode::BAD_REQUEST,
            "slowmode is off, 5, 10 or 30 seconds, 1, 5 or 15 minutes, or an hour".into(),
        ));
    }
    sqlx::query("UPDATE channels SET slowmode_seconds = ? WHERE id = ?")
        .bind(body.seconds)
        .bind(&channel_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let metadata = serde_json::json!({ "seconds": body.seconds }).to_string();
    crate::api::abuse::log_action(
        &state,
        crate::api::abuse::ActionLog {
            server_id: Some(&server_id),
            actor_id: &auth.0,
            action: "set_slowmode",
            target_type: "channel",
            target_id: &channel_id,
            report_id: None,
            metadata: Some(&metadata),
        },
    )
    .await?;
    broadcast_to_channel(
        &state,
        &channel_id,
        &GatewayEvent::SlowmodeUpdate {
            channel_id: channel_id.clone(),
            seconds: body.seconds,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

const SLOWMODE_PREFIX: &str = "slowmode: you can send again in ";

/// The refusal for a message sent too soon in slowmode; [`with_retry_after`] turns it into a
/// response carrying Retry-After.
fn slowmode_refusal(wait: i64) -> ApiError {
    (
        StatusCode::TOO_MANY_REQUESTS,
        format!("{SLOWMODE_PREFIX}{wait}s"),
    )
}

/// A refusal as a response; slowmode's says in Retry-After how many seconds to wait.
pub fn with_retry_after(error: ApiError) -> Response {
    let wait = if error.0 == StatusCode::TOO_MANY_REQUESTS {
        error
            .1
            .strip_prefix(SLOWMODE_PREFIX)
            .and_then(|rest| rest.trim_end_matches('s').parse::<i64>().ok())
    } else {
        None
    };
    let mut response = error.into_response();
    if let Some(wait) = wait {
        if let Ok(value) = HeaderValue::from_str(&wait.to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
    }
    response
}

/// Claim `user_id`'s next message in `channel_id` under its slowmode, or say how long to
/// wait. People who manage messages or channels aren't slowed down, and DMs have none.
pub async fn claim_slowmode(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<(), ApiError> {
    let row: Option<(Option<String>, i64)> =
        sqlx::query_as("SELECT server_id, slowmode_seconds FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let Some((Some(_), slowmode)) = row else {
        return Ok(());
    };
    if slowmode <= 0 {
        return Ok(());
    }
    let permissions = roles::channel_permissions(state, channel_id, user_id).await;
    if permissions & (perm::MANAGE_MESSAGES | perm::MANAGE_CHANNELS) != 0 {
        return Ok(());
    }
    let now = now_unix();
    // One statement, so two messages at once can't both take the slot: the mark moves
    // only when the last one is at least `slowmode` seconds old.
    let claimed = sqlx::query(
        "INSERT INTO slowmode_marks (channel_id, user_id, sent_at) VALUES (?,?,?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET sent_at = excluded.sent_at
         WHERE slowmode_marks.sent_at <= ?",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(now)
    .bind(now - slowmode)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    if claimed.rows_affected() > 0 {
        return Ok(());
    }
    let last: i64 = sqlx::query_scalar(
        "SELECT sent_at FROM slowmode_marks WHERE channel_id = ? AND user_id = ?",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Err(slowmode_refusal((last + slowmode - now).max(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slowmode_refusals_say_how_long_to_wait() {
        let response = with_retry_after(slowmode_refusal(7));
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "7");
        let other = with_retry_after((StatusCode::TOO_MANY_REQUESTS, "too fast".into()));
        assert!(other.headers().get(header::RETRY_AFTER).is_none());
    }
}
