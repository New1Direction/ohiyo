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
    .map_err(|e| crate::api::error::internal(e))?;

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
    .map_err(|e| crate::api::error::internal(e))?;

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
    .map_err(|e| crate::api::error::internal(e))?;

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
    .map_err(|e| crate::api::error::internal(e))?;

    for uid in [&auth.0, &body.recipient_id] {
        sqlx::query("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)")
            .bind(&id)
            .bind(uid)
            .execute(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
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
        disappearing_seconds: None,
        epoch: 0,
        owner_id: None,
    };

    Ok(Json(channel))
}

#[derive(Deserialize)]
pub struct OpenGroupDmBody {
    pub recipient_ids: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// POST /users/@me/group-dms — create a group DM with several people. Group E2E
/// (sender keys) layers on top of this channel; the server stays blind to content.
pub async fn open_group_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<OpenGroupDmBody>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    let mut members: Vec<String> = body
        .recipient_ids
        .into_iter()
        .filter(|u| !u.is_empty() && u != &auth.0)
        .collect();
    members.sort();
    members.dedup();
    if members.is_empty() || members.len() > 20 {
        return Err((StatusCode::BAD_REQUEST, "need 1–20 other people".into()));
    }

    let id = new_id();
    let now = now_unix();
    let name = body
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Group".to_owned());

    sqlx::query(
        "INSERT INTO channels (id, name, channel_type, position, created_at, owner_id) VALUES (?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&name)
    .bind("group_dm")
    .bind(0i64)
    .bind(now)
    .bind(&auth.0)
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;

    let participants: Vec<String> = std::iter::once(auth.0.clone()).chain(members).collect();
    for uid in &participants {
        sqlx::query("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)")
            .bind(&id)
            .bind(uid)
            .execute(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
    }

    let channel = Channel {
        id,
        server_id: None,
        name,
        channel_type: "group_dm".to_owned(),
        position: 0,
        topic: None,
        created_at: now,
        category_id: None,
        disappearing_seconds: None,
        epoch: 0,
        owner_id: Some(auth.0.clone()),
    };

    // Tell every participant about the new group live.
    for uid in &participants {
        crate::gateway::broadcast_to_user(
            &state.sessions,
            uid,
            &crate::types::GatewayEvent::ChannelCreate(channel.clone()),
        );
    }

    Ok(Json(channel))
}

/// GET /channels/{channel_id}/recipients — the participant list of a DM / group DM
/// (so a member can fan out sender-key distributions to everyone).
pub async fn list_recipients(
    auth: AuthUser,
    axum::extract::Path(channel_id): axum::extract::Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<PublicUser>>, (StatusCode, String)> {
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let users: Vec<User> = sqlx::query_as(
        "SELECT u.* FROM users u
         JOIN dm_participants dp ON dp.user_id = u.id
         WHERE dp.channel_id = ?",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;
    Ok(Json(users.into_iter().map(PublicUser::from).collect()))
}

// ── Group-DM membership management (with rekey) ─────────────────────────────────

fn internal(e: impl std::fmt::Display) -> (StatusCode, String) {
    crate::api::error::internal(e)
}

/// (channel_type, owner_id) for a channel, or 404 if it doesn't exist.
async fn channel_meta(
    state: &AppState,
    channel_id: &str,
) -> Result<(String, Option<String>), (StatusCode, String)> {
    sqlx::query_as("SELECT channel_type, owner_id FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "no such channel".into()))
}

/// Bump a group's rekey epoch and return the new value. Atomic increment-and-read
/// (RETURNING, SQLite ≥3.35) so concurrent membership changes can't observe a torn
/// epoch — the value always moves strictly forward.
async fn bump_epoch(state: &AppState, channel_id: &str) -> Result<i64, (StatusCode, String)> {
    sqlx::query_scalar("UPDATE channels SET epoch = epoch + 1 WHERE id = ? RETURNING epoch")
        .bind(channel_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal)
}

async fn participant_users(state: &AppState, channel_id: &str) -> Vec<PublicUser> {
    let users: Vec<User> = sqlx::query_as(
        "SELECT u.* FROM users u JOIN dm_participants dp ON dp.user_id = u.id WHERE dp.channel_id = ?",
    )
    .bind(channel_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    users.into_iter().map(PublicUser::from).collect()
}

fn members_event(
    channel_id: &str,
    epoch: i64,
    participants: Vec<PublicUser>,
) -> crate::types::GatewayEvent {
    crate::types::GatewayEvent::GroupMembersUpdate {
        channel_id: channel_id.to_owned(),
        epoch,
        participants,
    }
}

/// Tell the current participants their group's membership/epoch changed (so they rotate).
async fn broadcast_members(state: &AppState, channel_id: &str, epoch: i64) {
    let participants = participant_users(state, channel_id).await;
    crate::gateway::broadcast_to_channel(
        state,
        channel_id,
        &members_event(channel_id, epoch, participants),
    )
    .await;
}

#[derive(Deserialize)]
pub struct AddRecipientBody {
    pub user_id: String,
}

/// POST /channels/{channel_id}/recipients — add someone to a group DM. Any current
/// member may add. Bumps the rekey epoch so everyone rotates, and hands the newcomer
/// the channel itself.
pub async fn add_recipient(
    auth: AuthUser,
    axum::extract::Path(channel_id): axum::extract::Path<String>,
    State(state): State<AppState>,
    Json(body): Json<AddRecipientBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let new_user = body.user_id.trim().to_owned();
    if new_user.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing user_id".into()));
    }
    let (kind, _owner) = channel_meta(&state, &channel_id).await?;
    if kind != "group_dm" {
        return Err((StatusCode::BAD_REQUEST, "not a group DM".into()));
    }
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = ?")
        .bind(&new_user)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?;
    if exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "no such user".into()));
    }
    let already: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ?")
            .bind(&channel_id)
            .bind(&new_user)
            .fetch_optional(&state.db)
            .await
            .map_err(internal)?;
    if already.is_some() {
        return Ok(StatusCode::NO_CONTENT); // already a member → idempotent
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?")
            .bind(&channel_id)
            .fetch_one(&state.db)
            .await
            .map_err(internal)?;
    if count >= 21 {
        return Err((StatusCode::BAD_REQUEST, "group is full (max 21)".into()));
    }
    sqlx::query("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)")
        .bind(&channel_id)
        .bind(&new_user)
        .execute(&state.db)
        .await
        .map_err(internal)?;
    let epoch = bump_epoch(&state, &channel_id).await?;
    // The newcomer has no row for this channel yet — send them the channel first.
    if let Some(ch) = sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = ?")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
    {
        crate::gateway::broadcast_to_user(
            &state.sessions,
            &new_user,
            &crate::types::GatewayEvent::ChannelCreate(ch),
        );
    }
    broadcast_members(&state, &channel_id, epoch).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /channels/{channel_id}/recipients/{user_id} — remove a member (owner only)
/// or leave the group yourself. Bumps the rekey epoch so the remaining members rotate
/// their sender keys; the removed member can decrypt no future message.
pub async fn remove_recipient(
    auth: AuthUser,
    axum::extract::Path((channel_id, target)): axum::extract::Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let (kind, owner) = channel_meta(&state, &channel_id).await?;
    if kind != "group_dm" {
        return Err((StatusCode::BAD_REQUEST, "not a group DM".into()));
    }
    if !crate::api::messages::user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let is_self = target == auth.0;
    let is_owner = owner.as_deref() == Some(auth.0.as_str());
    if !is_self && !is_owner {
        return Err((
            StatusCode::FORBIDDEN,
            "only the group owner can remove others".into(),
        ));
    }
    let removed = sqlx::query("DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?")
        .bind(&channel_id)
        .bind(&target)
        .execute(&state.db)
        .await
        .map_err(internal)?
        .rows_affected();
    if removed == 0 {
        return Ok(StatusCode::NO_CONTENT); // wasn't a member → nothing to do
    }
    // If the owner just left, hand ownership to the earliest-joined remaining member so
    // the group stays administerable (otherwise nobody could remove anyone afterward).
    // Clients pick up the new owner on their next Ready/refetch.
    if owner.as_deref() == Some(target.as_str()) {
        let next_owner: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM dm_participants WHERE channel_id = ? ORDER BY rowid LIMIT 1",
        )
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?;
        sqlx::query("UPDATE channels SET owner_id = ? WHERE id = ?")
            .bind(&next_owner) // None → NULL when the group is now empty
            .bind(&channel_id)
            .execute(&state.db)
            .await
            .map_err(internal)?;
    }
    let epoch = bump_epoch(&state, &channel_id).await?;
    // Remaining members rotate. The query for broadcast resolves the *current* member
    // set, so the removed user is already excluded here.
    broadcast_members(&state, &channel_id, epoch).await;
    // Notify the removed user directly (they're no longer a channel recipient): they
    // see themselves absent from `participants` and drop the channel locally.
    let participants = participant_users(&state, &channel_id).await;
    crate::gateway::broadcast_to_user(
        &state.sessions,
        &target,
        &members_event(&channel_id, epoch, participants),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ── Dead-man's switch (account-level inactivity wipe) ───────────────────────────

/// Refresh a user's liveness timestamp. Called on gateway connect and on message send,
/// so an active user never trips their own dead-man's switch.
pub async fn touch_active(db: &sqlx::SqlitePool, user_id: &str) {
    let _ = sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
        .bind(now_unix())
        .bind(user_id)
        .execute(db)
        .await;
}

#[derive(Deserialize)]
pub struct DeadmanBody {
    /// Inactivity window in seconds; null/0 disables the switch.
    pub seconds: Option<i64>,
    /// 'history' (wipe my messages) or 'keys' (also wipe my server-side E2E directory).
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DeadmanConfig {
    pub seconds: Option<i64>,
    pub scope: String,
}

/// GET /users/@me/deadman — current dead-man's-switch configuration.
pub async fn get_deadman(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<DeadmanConfig>, (StatusCode, String)> {
    let row: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT deadman_seconds, deadman_scope FROM users WHERE id = ?")
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?;
    let (seconds, scope) = row.unwrap_or((None, None));
    Ok(Json(DeadmanConfig {
        seconds,
        scope: scope.unwrap_or_else(|| "history".to_owned()),
    }))
}

/// POST /users/@me/deadman — arm/disarm the switch. Resets liveness so it can't fire
/// immediately on configuration.
pub async fn set_deadman(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DeadmanBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let scope = match body.scope.as_deref() {
        Some("keys") => "keys",
        _ => "history",
    };
    // Clamp to [5 seconds, 1 year]; None/0/negative disables. (The UI offers day-scale
    // presets; a very short window via the raw API is a deliberate power-user choice.)
    let secs = body
        .seconds
        .filter(|s| *s > 0)
        .map(|s| s.clamp(5, 365 * 86_400));
    sqlx::query(
        "UPDATE users SET deadman_seconds = ?, deadman_scope = ?, last_active_at = ? WHERE id = ?",
    )
    .bind(secs)
    .bind(scope)
    .bind(now_unix())
    .bind(&auth.0)
    .execute(&state.db)
    .await
    .map_err(|e| crate::api::error::internal(e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Wipe data for users whose dead-man's switch has tripped (inactive past their window).
/// Driven by the periodic task in `main`. 'history' deletes their authored messages;
/// 'keys' also clears their server-side Signal directory + legacy public key.
pub async fn sweep_deadman(state: &AppState) {
    let now = now_unix();
    let tripped: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, deadman_scope FROM users
         WHERE deadman_seconds IS NOT NULL
           AND last_active_at IS NOT NULL
           AND last_active_at < ? - deadman_seconds",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for (uid, scope) in tripped {
        let _ = sqlx::query("DELETE FROM messages WHERE author_id = ?")
            .bind(&uid)
            .execute(&state.db)
            .await;
        if scope.as_deref() == Some("keys") {
            for q in [
                "DELETE FROM signal_identity WHERE user_id = ?",
                "DELETE FROM signal_one_time_prekeys WHERE user_id = ?",
                "UPDATE users SET public_key = NULL WHERE id = ?",
            ] {
                let _ = sqlx::query(q).bind(&uid).execute(&state.db).await;
            }
        }
    }
}
