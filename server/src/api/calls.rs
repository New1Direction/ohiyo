//! Calls in DMs and group chats, like Discord's.
//!
//! The voice itself is the ordinary voice room of the chat's channel (`JoinVoice` already lets
//! a chat's own people in, and nobody else). This module adds what makes it a call:
//! - **Ringing.** `POST /channels/{id}/call` rings everyone else in the chat on every device
//!   they're signed in on (`CallRing`), with a content-free push for those who are offline.
//!   A blocked person can't ring you.
//! - **A call log.** The call leaves one message in the chat (`messages.call_log`, JSON) that
//!   the server keeps up to date: ringing → ongoing → ended (with its length), missed or
//!   declined. Nobody can edit it or reply to it.
//! - **Answering and ending.** Joining the chat's voice room answers (the ring stops on the
//!   answerer's other devices). A one-to-one call ends when either person hangs up, a group
//!   call when the last person leaves; a call nobody answers is missed after
//!   `AppState::call_ring_secs`, and the caller hanging up first makes it missed too.
//!
//! Sessions live in memory, like voice rooms: a restart ends every call, and the sweeper then
//! closes the logs those calls left open (`sweep_stale_logs`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;

use crate::{
    auth::AuthUser,
    gateway::{broadcast_to_channel, broadcast_to_user},
    types::{new_id, now_unix, GatewayEvent, Message, PublicUser, User},
    AppState,
};

/// One call in progress, keyed by its chat's channel id.
#[derive(Clone, Debug)]
pub struct CallSession {
    /// Tells this call apart from a later one in the same chat (for the ring timer).
    pub id: u64,
    /// The chat message that holds this call's log.
    pub message_id: String,
    pub caller_id: String,
    pub video: bool,
    pub started_at: i64,
    /// When someone other than the caller joined; None while it only rings.
    pub answered_at: Option<i64>,
    /// People whose devices are still ringing.
    pub ringing: HashSet<String>,
    /// Who declined last, for a call that ends declined.
    pub declined_by: Option<String>,
}

/// channel_id → the call going on in that chat.
pub type CallSessions = Arc<Mutex<HashMap<String, CallSession>>>;

pub fn new_call_sessions() -> CallSessions {
    Arc::new(Mutex::new(HashMap::new()))
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// Calls one account may start per minute.
const STARTS_PER_MINUTE: usize = 10;

type ApiError = (StatusCode, String);

#[derive(Deserialize)]
pub struct StartCallBody {
    #[serde(default)]
    pub video: bool,
}

#[derive(Serialize)]
pub struct StartCallResponse {
    pub message_id: String,
    /// The people being rung.
    pub ringing: Vec<String>,
}

/// The chat's type ("dm" or "group_dm") and its people. Err for a space channel (400) or a
/// chat that doesn't exist or doesn't include `user_id` (404: no telling which).
async fn chat_people(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<(String, Vec<String>), ApiError> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT server_id, channel_type FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let not_found = || (StatusCode::NOT_FOUND, "chat not found".to_string());
    let Some((server_id, channel_type)) = row else {
        return Err(not_found());
    };
    let people: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM dm_participants WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_all(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if server_id.is_some() {
        // A space's channel: only say what it is to someone who can see it.
        if !crate::api::messages::user_can_access(state, channel_id, user_id).await {
            return Err(not_found());
        }
        return Err((
            StatusCode::BAD_REQUEST,
            "calls are for DMs and group chats; spaces have voice channels".into(),
        ));
    }
    if !people.iter().any(|p| p == user_id) {
        return Err(not_found());
    }
    Ok((channel_type, people))
}

/// True when `user_id` has this chat muted right now.
async fn chat_muted_for(state: &AppState, user_id: &str, channel_id: &str) -> bool {
    let row: Option<(bool, Option<i64>)> = sqlx::query_as(
        "SELECT muted, muted_until FROM notification_settings
          WHERE user_id = ? AND target_type = 'channel' AND target_id = ?",
    )
    .bind(user_id)
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let now = now_unix();
    matches!(row, Some((true, until)) if until.is_none_or(|u| u > now))
}

async fn load_public_user(state: &AppState, user_id: &str) -> Option<PublicUser> {
    sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(PublicUser::from)
}

/// Write a call's log onto its message and show everyone in the chat.
async fn publish_log(state: &AppState, channel_id: &str, message_id: &str, log: serde_json::Value) {
    let raw = log.to_string();
    if let Err(e) = sqlx::query("UPDATE messages SET call_log = ? WHERE id = ?")
        .bind(&raw)
        .bind(message_id)
        .execute(&state.db)
        .await
    {
        tracing::warn!("call log update failed for {message_id}: {e}");
        return;
    }
    broadcast_log(state, channel_id, message_id).await;
}

/// Show everyone in the chat a call log message as it is now.
async fn broadcast_log(state: &AppState, channel_id: &str, message_id: &str) {
    let msg: Option<Message> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
        .bind(message_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let Some(msg) = msg else { return };
    let author = msg.author_id.clone();
    if let Ok(full) = crate::api::messages::build_full(state, msg, &author).await {
        broadcast_to_channel(state, channel_id, &GatewayEvent::MessageUpdate(full)).await;
    }
}

fn ring_stop(channel_id: &str, message_id: &str, reason: &str) -> GatewayEvent {
    GatewayEvent::CallRingStop {
        channel_id: channel_id.to_string(),
        message_id: message_id.to_string(),
        reason: reason.to_string(),
    }
}

/// POST /channels/{channel_id}/call — start a call in a DM or group chat and ring the
/// others. If a call is already going on there, answers with that one (the caller then just
/// joins it).
pub async fn start_call(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<StartCallBody>,
) -> Result<Json<StartCallResponse>, ApiError> {
    let (channel_type, people) = chat_people(&state, &channel_id, &auth.0).await?;
    if !state.rate.check(
        &format!("call-start:{}", auth.0),
        STARTS_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many calls — wait a minute".into(),
        ));
    }

    let existing = {
        let calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        calls.get(&channel_id).map(|s| StartCallResponse {
            message_id: s.message_id.clone(),
            ringing: s.ringing.iter().cloned().collect(),
        })
    };
    if let Some(existing) = existing {
        return Ok(Json(existing));
    }

    let mut ringing = Vec::new();
    for other in people.iter().filter(|p| **p != auth.0) {
        if !crate::api::abuse::is_blocked_pair(&state, &auth.0, other).await {
            ringing.push(other.clone());
        }
    }
    if channel_type == "dm" && ringing.is_empty() {
        return Err((StatusCode::FORBIDDEN, "you can't call this person".into()));
    }

    let now = now_unix();
    let message_id = new_id();
    let log = json!({ "state": "ringing", "video": body.video, "started_at": now });
    let expires_at = crate::api::messages::disappearing_expiry(&state, &channel_id, now).await;
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, expires_at, call_log)
         VALUES (?,?,?,'',?,?,?)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&auth.0)
    .bind(now)
    .bind(expires_at)
    .bind(log.to_string())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let raced = {
        let mut calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(other) = calls.get(&channel_id) {
            Some(StartCallResponse {
                message_id: other.message_id.clone(),
                ringing: other.ringing.iter().cloned().collect(),
            })
        } else {
            calls.insert(
                channel_id.clone(),
                CallSession {
                    id: session_id,
                    message_id: message_id.clone(),
                    caller_id: auth.0.clone(),
                    video: body.video,
                    started_at: now,
                    answered_at: None,
                    ringing: ringing.iter().cloned().collect(),
                    declined_by: None,
                },
            );
            None
        }
    };
    if let Some(other) = raced {
        // Someone else in the chat started a call at the same moment: keep theirs.
        let _ = sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(&message_id)
            .execute(&state.db)
            .await;
        return Ok(Json(other));
    }

    // The log message, for everyone in the chat.
    let msg: Option<Message> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
        .bind(&message_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if let Some(msg) = msg {
        if let Ok(full) = crate::api::messages::build_full(&state, msg, &auth.0).await {
            broadcast_to_channel(&state, &channel_id, &GatewayEvent::MessageCreate(full)).await;
        }
    }

    // Ring everyone else on every device; wake the offline ones who haven't muted the chat.
    let ring_until = now + state.call_ring_secs as i64;
    if let Some(caller) = load_public_user(&state, &auth.0).await {
        let ring = GatewayEvent::CallRing {
            channel_id: channel_id.clone(),
            message_id: message_id.clone(),
            caller,
            video: body.video,
            ring_until,
        };
        for uid in &ringing {
            broadcast_to_user(&state.sessions, uid, &ring);
        }
    }
    let mut wake = Vec::new();
    for uid in &ringing {
        if !chat_muted_for(&state, uid, &channel_id).await {
            wake.push(uid.clone());
        }
    }
    crate::api::push::queue_call_pushes(&state, &wake).await;

    let timer_state = state.clone();
    let timer_channel = channel_id.clone();
    let ring_for = Duration::from_secs(state.call_ring_secs);
    tokio::spawn(async move {
        tokio::time::sleep(ring_for).await;
        ring_timed_out(&timer_state, &timer_channel, session_id).await;
    });

    Ok(Json(StartCallResponse {
        message_id,
        ringing,
    }))
}

/// POST /channels/{channel_id}/call/decline — stop the ring on all your devices. A
/// one-to-one call (or a group call everyone declined) ends as declined.
pub async fn decline_call(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    chat_people(&state, &channel_id, &auth.0).await?;
    let outcome = {
        let mut calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        calls.get_mut(&channel_id).and_then(|s| {
            if !s.ringing.remove(&auth.0) {
                return None;
            }
            s.declined_by = Some(auth.0.clone());
            let over = s.answered_at.is_none() && s.ringing.is_empty();
            Some((s.message_id.clone(), s.id, over))
        })
    };
    let Some((message_id, session_id, over)) = outcome else {
        return Ok(StatusCode::NO_CONTENT);
    };
    broadcast_to_user(
        &state.sessions,
        &auth.0,
        &ring_stop(&channel_id, &message_id, "declined"),
    );
    if over {
        finish(
            &state,
            &channel_id,
            Some(session_id),
            "declined",
            "declined",
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Someone joined the chat's voice room. If a call is ringing there and they're not the
/// caller, they answered: their other devices stop ringing, and the log says it's on.
pub async fn on_join(state: &AppState, channel_id: &str, user_id: &str) {
    let change = {
        let mut calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        let Some(s) = calls.get_mut(channel_id) else {
            return;
        };
        if s.caller_id == user_id {
            return;
        }
        let was_ringing = s.ringing.remove(user_id);
        let first_answer = s.answered_at.is_none();
        let now = now_unix();
        if first_answer {
            s.answered_at = Some(now);
        }
        (
            s.message_id.clone(),
            was_ringing,
            first_answer.then(|| {
                json!({
                    "state": "ongoing",
                    "video": s.video,
                    "started_at": s.started_at,
                    "answered_at": now,
                })
            }),
        )
    };
    let (message_id, was_ringing, log) = change;
    if was_ringing {
        broadcast_to_user(
            &state.sessions,
            user_id,
            &ring_stop(channel_id, &message_id, "answered"),
        );
    }
    if let Some(log) = log {
        publish_log(state, channel_id, &message_id, log).await;
    }
}

/// Someone left the chat's voice room (hung up, was removed or disconnected). A one-to-one
/// call that was answered ends when either person goes; any other call ends when the room is
/// empty. Hanging up before anyone answered makes it a missed call.
pub async fn on_leave(state: &AppState, channel_id: &str) {
    let has_call = {
        let calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        calls.contains_key(channel_id)
    };
    if !has_call {
        return;
    }
    let one_to_one =
        sqlx::query_scalar::<_, String>("SELECT channel_type FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .is_some_and(|t| t == "dm");
    let left = {
        let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
        rooms.get(channel_id).map_or(0, |r| r.len())
    };
    let answered = {
        let calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        match calls.get(channel_id) {
            Some(s) => s.answered_at.is_some(),
            None => return,
        }
    };
    if answered {
        if left == 0 || (one_to_one && left <= 1) {
            finish(state, channel_id, None, "ended", "missed").await;
        }
    } else if left == 0 {
        finish(state, channel_id, None, "missed", "cancelled").await;
    }
}

/// The ring ran out. Nobody answered: the call is missed. Someone did (a group call): the
/// others stop ringing and can still join from the chat.
async fn ring_timed_out(state: &AppState, channel_id: &str, session_id: u64) {
    let stale = {
        let mut calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        match calls.get_mut(channel_id) {
            Some(s) if s.id == session_id => {
                if s.answered_at.is_some() {
                    let left: Vec<String> = s.ringing.drain().collect();
                    Some((s.message_id.clone(), left, true))
                } else {
                    Some((s.message_id.clone(), Vec::new(), false))
                }
            }
            _ => None,
        }
    };
    match stale {
        Some((message_id, left, true)) => {
            let stop = ring_stop(channel_id, &message_id, "missed");
            for uid in left {
                broadcast_to_user(&state.sessions, &uid, &stop);
            }
        }
        Some((_, _, false)) => {
            finish(state, channel_id, Some(session_id), "missed", "missed").await
        }
        None => {}
    }
}

/// End a call: stop any ring still going (`stop_reason`), tell everyone in the chat so anyone
/// still in it hangs up, and write the final log (`outcome`: ended, missed or declined).
/// With `session_id`, only ends that call (not a newer one in the same chat).
async fn finish(
    state: &AppState,
    channel_id: &str,
    session_id: Option<u64>,
    outcome: &str,
    stop_reason: &str,
) {
    let session = {
        let mut calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        match calls.get(channel_id) {
            Some(s) if session_id.is_none_or(|id| id == s.id) => calls.remove(channel_id),
            _ => None,
        }
    };
    let Some(s) = session else { return };
    let now = now_unix();
    let stop = ring_stop(channel_id, &s.message_id, stop_reason);
    for uid in &s.ringing {
        broadcast_to_user(&state.sessions, uid, &stop);
    }
    let mut log = json!({
        "state": outcome,
        "video": s.video,
        "started_at": s.started_at,
        "answered_at": s.answered_at,
        "ended_at": now,
    });
    if let Some(answered) = s.answered_at {
        log["duration_secs"] = json!((now - answered).max(0));
    }
    if outcome == "declined" {
        log["declined_by"] = json!(s.declined_by);
    }
    // Anyone still in the call hangs up first; then the log says how it went.
    broadcast_to_channel(
        state,
        channel_id,
        &GatewayEvent::CallEnded {
            channel_id: channel_id.to_string(),
            message_id: s.message_id.clone(),
            outcome: outcome.to_string(),
        },
    )
    .await;
    publish_log(state, channel_id, &s.message_id, log).await;
}

/// How old a call log must be before the sweep may close it: a new call writes its log a
/// moment before the call itself is registered.
const STALE_LOG_AFTER_SECS: i64 = 30;

/// Close the logs of calls that aren't going on any more. Calls live in memory, so a restart
/// in the middle of one leaves its log saying ringing or ongoing: a ringing call becomes
/// missed, an answered one ended (how long it lasted isn't known).
pub async fn sweep_stale_logs(state: &AppState) {
    let open: Vec<(String, String, String)> = match sqlx::query_as(
        "SELECT id, channel_id, call_log FROM messages
          WHERE call_log IS NOT NULL AND created_at < ?
            AND json_extract(call_log, '$.state') IN ('ringing', 'ongoing')",
    )
    .bind(now_unix() - STALE_LOG_AFTER_SECS)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("call log sweep failed: {e}");
            return;
        }
    };
    if open.is_empty() {
        return;
    }
    let live: HashSet<String> = {
        let calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        calls.values().map(|s| s.message_id.clone()).collect()
    };
    for (message_id, channel_id, raw) in open {
        if live.contains(&message_id) {
            continue;
        }
        let Ok(mut log) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let answered = log.get("answered_at").is_some_and(|v| v.is_i64());
        log["state"] = json!(if answered { "ended" } else { "missed" });
        // Only if nothing wrote it in the meantime (a call that was just finishing).
        let closed = sqlx::query("UPDATE messages SET call_log = ? WHERE id = ? AND call_log = ?")
            .bind(log.to_string())
            .bind(&message_id)
            .bind(&raw)
            .execute(&state.db)
            .await
            .is_ok_and(|r| r.rows_affected() == 1);
        if closed {
            broadcast_log(state, &channel_id, &message_id).await;
        }
    }
}

/// A device that connects while a call rings for its person rings too.
pub async fn replay_rings(state: &AppState, user_id: &str, tx: &broadcast::Sender<GatewayEvent>) {
    let rings: Vec<(String, String, String, bool, i64)> = {
        let calls = state.calls.lock().unwrap_or_else(|e| e.into_inner());
        calls
            .iter()
            .filter(|(_, s)| s.ringing.contains(user_id))
            .map(|(cid, s)| {
                (
                    cid.clone(),
                    s.message_id.clone(),
                    s.caller_id.clone(),
                    s.video,
                    s.started_at + state.call_ring_secs as i64,
                )
            })
            .collect()
    };
    for (channel_id, message_id, caller_id, video, ring_until) in rings {
        if let Some(caller) = load_public_user(state, &caller_id).await {
            let _ = tx.send(GatewayEvent::CallRing {
                channel_id,
                message_id,
                caller,
                video,
                ring_until,
            });
        }
    }
}

/// The seat limit for a chat's voice room: Some(cap) for a DM or group chat (peer-to-peer
/// voice), None for a space's voice channel.
pub async fn seat_cap(state: &AppState, channel_id: &str) -> Option<usize> {
    let server_id: Option<Option<String>> =
        sqlx::query_scalar("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    match server_id {
        Some(None) => Some(state.dm_call_cap),
        _ => None,
    }
}
