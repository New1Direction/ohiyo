//! Scheduled events in a space: a title, a start and an optional end, a place (one of the
//! space's voice or text channels, or a place of the host's own), an optional cover, and
//! three answers (Interested, Going, Can't go). The host or a manager edits or cancels;
//! cancelling tells everyone who answered. Reminders live in `event_reminders`.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    api::event_reminders::{notify_answered, Phase},
    auth::AuthUser,
    gateway::broadcast_to_server,
    types::{new_id, now_unix, GatewayEvent, PublicUser},
    AppState,
};

pub use crate::api::event_reminders::send_due_reminders;

/// A start a minute in the past still counts as now (a slow form, a skewed clock).
const PAST_GRACE_SECS: i64 = 60;
/// Events can be planned up to two years ahead.
const MAX_AHEAD_SECS: i64 = 2 * 366 * 24 * 60 * 60;
/// And last up to a month.
const MAX_LENGTH_SECS: i64 = 31 * 24 * 60 * 60;
/// A place of your own: an address, a venue or a link.
const PLACE_MAX_CHARS: usize = 100;
/// How many of the people going a card shows.
const GOING_PREVIEW: usize = 8;
/// The calendar keeps three months of past events, and at most this many in all.
const LIST_PAST_SECS: i64 = 90 * 24 * 60 * 60;
const LIST_LIMIT: i64 = 500;
/// Creating, editing and cancelling per person per minute; answers have their own budget.
const WRITES_PER_MINUTE: usize = 20;
const ANSWERS_PER_MINUTE: usize = 60;
const STATUSES: [&str; 3] = ["interested", "going", "not_going"];

type ApiError = (StatusCode, String);

fn bad(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct EventLocation {
    /// "voice" or "text" (one of the space's channels) or "place" (the host's own words).
    pub kind: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Serialize, Default)]
pub struct RsvpCounts {
    pub interested: i64,
    pub going: i64,
    pub not_going: i64,
}

#[derive(Serialize)]
pub struct EventInfo {
    pub id: String,
    pub server_id: String,
    pub title: String,
    pub description: Option<String>,
    pub starts_at: i64,
    pub ends_at: Option<i64>,
    pub created_by: String,
    /// How many are going, and whether the caller is: what desktop 0.3.x reads.
    pub rsvp_count: i64,
    pub me_rsvp: bool,
    pub location: Option<EventLocation>,
    pub cover_url: Option<String>,
    pub cancelled: bool,
    pub counts: RsvpCounts,
    /// The caller's answer: "interested", "going", "not_going", or null.
    pub me_status: Option<String>,
    /// Some of the people going, longest-standing answer first.
    pub going: Vec<PublicUser>,
}

#[derive(sqlx::FromRow)]
struct EventRow {
    id: String,
    title: String,
    description: Option<String>,
    starts_at: i64,
    ends_at: Option<i64>,
    created_by: String,
    location_kind: Option<String>,
    location_channel_id: Option<String>,
    location_text: Option<String>,
    cover_file_id: Option<String>,
    cancelled_at: Option<i64>,
    interested: i64,
    going: i64,
    not_going: i64,
    me_status: Option<String>,
}

fn location_of(row: &EventRow) -> Option<EventLocation> {
    row.location_kind.as_ref().map(|kind| EventLocation {
        kind: kind.clone(),
        channel_id: row.location_channel_id.clone(),
        text: row.location_text.clone(),
    })
}

async fn require_member(state: &AppState, server_id: &str, user_id: &str) -> Result<(), ApiError> {
    if crate::api::servers::is_member(state, server_id, user_id).await {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "not a member".into()))
    }
}

fn check_rate(state: &AppState, key: &str, user_id: &str, limit: usize) -> Result<(), ApiError> {
    if state
        .rate
        .check(&format!("{key}:{user_id}"), limit, Duration::from_secs(60))
    {
        Ok(())
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "slow down a little and try again".into(),
        ))
    }
}

/// GET /servers/{server_id}/events — the calendar: events from the last three months on,
/// earliest first, with answers.
pub async fn list_events(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<EventInfo>>, ApiError> {
    require_member(&state, &server_id, &auth.0).await?;
    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.created_by,
                e.location_kind, e.location_channel_id, e.location_text, e.cover_file_id,
                e.cancelled_at,
                (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'interested') AS interested,
                (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going,
                (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'not_going') AS not_going,
                (SELECT r.status FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS me_status
           FROM events e
          WHERE e.server_id = ? AND COALESCE(e.ends_at, e.starts_at) >= ?
          ORDER BY e.starts_at
          LIMIT ?",
    )
    .bind(&auth.0)
    .bind(&server_id)
    .bind(now_unix() - LIST_PAST_SECS)
    .bind(LIST_LIMIT)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let mut going = going_preview(&state, &server_id).await?;
    let out = rows
        .into_iter()
        .map(|row| EventInfo {
            server_id: server_id.clone(),
            location: location_of(&row),
            // Relative and signed, like attachments: the app reads it against its file server.
            cover_url: row.cover_file_id.as_deref().map(crate::signed_file_path),
            cancelled: row.cancelled_at.is_some(),
            rsvp_count: row.going,
            me_rsvp: row.me_status.as_deref() == Some("going"),
            counts: RsvpCounts {
                interested: row.interested,
                going: row.going,
                not_going: row.not_going,
            },
            going: going.remove(&row.id).unwrap_or_default(),
            id: row.id,
            title: row.title,
            description: row.description,
            starts_at: row.starts_at,
            ends_at: row.ends_at,
            created_by: row.created_by,
            me_status: row.me_status,
        })
        .collect();
    Ok(Json(out))
}

/// The first few people going to each of a space's events, in the order they answered.
async fn going_preview(
    state: &AppState,
    server_id: &str,
) -> Result<std::collections::HashMap<String, Vec<PublicUser>>, ApiError> {
    let rows: Vec<(String, String, String, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT r.event_id, u.id, u.username, u.display_name, u.avatar_url, u.is_bot
           FROM event_rsvps r
           JOIN events e ON e.id = r.event_id
           JOIN users u ON u.id = r.user_id
          WHERE e.server_id = ? AND r.status = 'going' AND COALESCE(e.ends_at, e.starts_at) >= ?
          ORDER BY r.rowid",
    )
    .bind(server_id)
    .bind(now_unix() - LIST_PAST_SECS)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let mut out: std::collections::HashMap<String, Vec<PublicUser>> = Default::default();
    for (event_id, id, username, display_name, avatar_url, bot) in rows {
        let list = out.entry(event_id).or_default();
        if list.len() < GOING_PREVIEW {
            list.push(PublicUser {
                id,
                username,
                display_name,
                avatar_url,
                bot,
            });
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct CreateEventBody {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub starts_at: i64,
    #[serde(default)]
    pub ends_at: Option<i64>,
    #[serde(default)]
    pub location: Option<EventLocation>,
    #[serde(default)]
    pub cover_file_id: Option<String>,
}

fn clean_title(title: &str) -> Result<String, ApiError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(bad("give your event a name"));
    }
    crate::api::limits::check_len("event title", title, crate::api::limits::EVENT_TITLE)?;
    Ok(title.to_owned())
}

fn clean_description(description: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(description) = description.map(str::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    crate::api::limits::check_len(
        "event description",
        description,
        crate::api::limits::EVENT_DESCRIPTION,
    )?;
    Ok(Some(description.to_owned()))
}

/// A start that isn't in the past (a minute's grace) and is at most two years ahead.
fn check_start(starts_at: i64, now: i64) -> Result<(), ApiError> {
    if starts_at < now - PAST_GRACE_SECS {
        return Err(bad("that time has already passed"));
    }
    if starts_at > now + MAX_AHEAD_SECS {
        return Err(bad("events can be planned up to two years ahead"));
    }
    Ok(())
}

fn check_end(starts_at: i64, ends_at: Option<i64>) -> Result<(), ApiError> {
    match ends_at {
        Some(end) if end <= starts_at => Err(bad("an event has to end after it starts")),
        Some(end) if end - starts_at > MAX_LENGTH_SECS => {
            Err(bad("an event can last up to a month"))
        }
        _ => Ok(()),
    }
}

/// A place of your own: one line of up to 100 characters; a link only if it's http(s).
fn clean_place(text: Option<&str>) -> Result<String, ApiError> {
    let text = text.map(str::trim).unwrap_or_default();
    if text.is_empty() {
        return Err(bad("say where it is"));
    }
    if text.chars().count() > PLACE_MAX_CHARS {
        return Err(bad("a place can be up to 100 characters"));
    }
    if text.chars().any(char::is_control) {
        return Err(bad("a place is one line"));
    }
    let lower = text.to_ascii_lowercase();
    let web = lower.starts_with("http://") || lower.starts_with("https://");
    let scheme_like = ["javascript:", "data:", "vbscript:", "file:"]
        .iter()
        .any(|s| lower.starts_with(s));
    if scheme_like || (lower.contains("://") && !web) {
        return Err(bad("a link has to start with http:// or https://"));
    }
    Ok(text.to_owned())
}

/// A location the caller may use: a voice or text channel of this space they can see, or a
/// place. Returns it tidied (a channel location carries no text; a place no channel).
async fn check_location(
    state: &AppState,
    server_id: &str,
    user_id: &str,
    location: &EventLocation,
) -> Result<EventLocation, ApiError> {
    match location.kind.as_str() {
        "voice" | "text" => {
            let channel_id = location
                .channel_id
                .as_deref()
                .ok_or_else(|| bad("pick a channel"))?;
            let kind: Option<String> = sqlx::query_scalar(
                "SELECT channel_type FROM channels WHERE id = ? AND server_id = ?",
            )
            .bind(channel_id)
            .bind(server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
            if kind.as_deref() != Some(location.kind.as_str()) {
                return Err(bad("that channel isn't one of this space's"));
            }
            if !crate::api::messages::user_can_access(state, channel_id, user_id).await {
                return Err(bad("that channel isn't one of this space's"));
            }
            Ok(EventLocation {
                kind: location.kind.clone(),
                channel_id: Some(channel_id.to_owned()),
                text: None,
            })
        }
        "place" => Ok(EventLocation {
            kind: "place".into(),
            channel_id: None,
            text: Some(clean_place(location.text.as_deref())?),
        }),
        _ => Err(bad(
            "a location is a voice channel, a text channel or a place",
        )),
    }
}

/// A cover has to be an image the caller uploaded.
async fn check_cover(state: &AppState, user_id: &str, file_id: &str) -> Result<(), ApiError> {
    let content_type: Option<String> =
        sqlx::query_scalar("SELECT content_type FROM files WHERE id = ? AND uploader_id = ?")
            .bind(file_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    match content_type {
        Some(ct) if ct.starts_with("image/") => Ok(()),
        _ => Err(bad("a cover has to be an image you uploaded")),
    }
}

async fn events_changed(state: &AppState, server_id: &str) {
    broadcast_to_server(
        state,
        server_id,
        &GatewayEvent::EventsChanged {
            server_id: server_id.to_owned(),
        },
    )
    .await;
}

/// POST /servers/{server_id}/events — any member can plan an event; they're down as Going.
pub async fn create_event(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateEventBody>,
) -> Result<StatusCode, ApiError> {
    require_member(&state, &server_id, &auth.0).await?;
    let title = clean_title(&body.title)?;
    let description = clean_description(body.description.as_deref())?;
    let now = now_unix();
    check_start(body.starts_at, now)?;
    check_end(body.starts_at, body.ends_at)?;
    let location = match &body.location {
        Some(location) => Some(check_location(&state, &server_id, &auth.0, location).await?),
        None => None,
    };
    if let Some(cover) = &body.cover_file_id {
        check_cover(&state, &auth.0, cover).await?;
    }
    check_rate(&state, "events", &auth.0, WRITES_PER_MINUTE)?;

    let id = new_id();
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    sqlx::query(
        "INSERT INTO events (id, server_id, title, description, starts_at, ends_at, created_by,
                             created_at, location_kind, location_channel_id, location_text,
                             cover_file_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&title)
    .bind(&description)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(&auth.0)
    .bind(now)
    .bind(location.as_ref().map(|l| l.kind.clone()))
    .bind(location.as_ref().and_then(|l| l.channel_id.clone()))
    .bind(location.as_ref().and_then(|l| l.text.clone()))
    .bind(&body.cover_file_id)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    sqlx::query("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')")
        .bind(&id)
        .bind(&auth.0)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    tx.commit().await.map_err(crate::api::error::internal)?;

    events_changed(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Absent stays absent; `null` becomes `Some(None)`: "clear it".
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub struct EditEventBody {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub starts_at: Option<i64>,
    #[serde(default, deserialize_with = "present")]
    pub ends_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "present")]
    pub location: Option<Option<EventLocation>>,
    #[serde(default, deserialize_with = "present")]
    pub cover_file_id: Option<Option<String>>,
}

#[derive(sqlx::FromRow)]
struct Stored {
    title: String,
    description: Option<String>,
    starts_at: i64,
    ends_at: Option<i64>,
    created_by: String,
    location_kind: Option<String>,
    location_channel_id: Option<String>,
    location_text: Option<String>,
    cover_file_id: Option<String>,
    cancelled_at: Option<i64>,
}

/// The event, if it's in this space and the caller is its host or can manage the space.
async fn load_for_host(
    state: &AppState,
    server_id: &str,
    event_id: &str,
    user_id: &str,
) -> Result<Stored, ApiError> {
    let stored: Option<Stored> = sqlx::query_as(
        "SELECT title, description, starts_at, ends_at, created_by, location_kind,
                location_channel_id, location_text, cover_file_id, cancelled_at
           FROM events WHERE id = ? AND server_id = ?",
    )
    .bind(event_id)
    .bind(server_id)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let stored = stored.ok_or((StatusCode::NOT_FOUND, "event not found".into()))?;
    if stored.created_by != user_id
        && !crate::api::roles::has_perm(
            state,
            server_id,
            user_id,
            crate::api::roles::perm::MANAGE_SERVER,
        )
        .await
    {
        return Err((
            StatusCode::FORBIDDEN,
            "only the host or a manager can change this".into(),
        ));
    }
    Ok(stored)
}

/// PATCH /servers/{server_id}/events/{event_id} — the host or a manager edits it. Fields
/// left out stay as they are; `null` clears an optional one. A new start time means the
/// reminders go again.
pub async fn edit_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<EditEventBody>,
) -> Result<StatusCode, ApiError> {
    let stored = load_for_host(&state, &server_id, &event_id, &auth.0).await?;
    if stored.cancelled_at.is_some() {
        return Err((StatusCode::CONFLICT, "this event was cancelled".into()));
    }
    let now = now_unix();
    let title = match &body.title {
        Some(title) => clean_title(title)?,
        None => stored.title,
    };
    let description = match &body.description {
        Some(description) => clean_description(description.as_deref())?,
        None => stored.description,
    };
    let starts_at = body.starts_at.unwrap_or(stored.starts_at);
    let moved = starts_at != stored.starts_at;
    if moved {
        check_start(starts_at, now)?;
    }
    let ends_at = body.ends_at.unwrap_or(stored.ends_at);
    check_end(starts_at, ends_at)?;
    let stored_location = stored.location_kind.map(|kind| EventLocation {
        kind,
        channel_id: stored.location_channel_id,
        text: stored.location_text,
    });
    let location = match &body.location {
        Some(Some(location)) if Some(location) != stored_location.as_ref() => {
            Some(check_location(&state, &server_id, &auth.0, location).await?)
        }
        Some(Some(_)) => stored_location,
        Some(None) => None,
        None => stored_location,
    };
    let cover = match &body.cover_file_id {
        Some(Some(id)) if Some(id) != stored.cover_file_id.as_ref() => {
            check_cover(&state, &auth.0, id).await?;
            Some(id.clone())
        }
        Some(Some(_)) | None => stored.cover_file_id,
        Some(None) => None,
    };
    check_rate(&state, "events", &auth.0, WRITES_PER_MINUTE)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(crate::api::error::internal)?;
    sqlx::query(
        "UPDATE events SET title = ?, description = ?, starts_at = ?, ends_at = ?,
                location_kind = ?, location_channel_id = ?, location_text = ?,
                cover_file_id = ?, updated_at = ?
          WHERE id = ?",
    )
    .bind(&title)
    .bind(&description)
    .bind(starts_at)
    .bind(ends_at)
    .bind(location.as_ref().map(|l| l.kind.clone()))
    .bind(location.as_ref().and_then(|l| l.channel_id.clone()))
    .bind(location.as_ref().and_then(|l| l.text.clone()))
    .bind(&cover)
    .bind(now)
    .bind(&event_id)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    if moved {
        sqlx::query(
            "UPDATE event_rsvps SET reminded_soon = 0, reminded_start = 0 WHERE event_id = ?",
        )
        .bind(&event_id)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    }
    tx.commit().await.map_err(crate::api::error::internal)?;

    events_changed(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /servers/{server_id}/events/{event_id}/cancel — the host or a manager calls it off.
/// It stays on the calendar marked Cancelled, and everyone who said Interested or Going
/// hears about it.
pub async fn cancel_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    let stored = load_for_host(&state, &server_id, &event_id, &auth.0).await?;
    if stored.cancelled_at.is_some() {
        return Err((StatusCode::CONFLICT, "already cancelled".into()));
    }
    check_rate(&state, "events", &auth.0, WRITES_PER_MINUTE)?;
    let now = now_unix();
    sqlx::query("UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(now)
        .bind(&event_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    events_changed(&state, &server_id).await;

    let answered: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM event_rsvps
          WHERE event_id = ? AND status IN ('interested', 'going') AND user_id != ?",
    )
    .bind(&event_id)
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let event = GatewayEvent::EventReminder {
        server_id: server_id.clone(),
        event_id,
        title: stored.title,
        starts_at: stored.starts_at,
        phase: Phase::Cancelled.as_str().into(),
        location_kind: stored.location_kind,
        location_channel_id: stored.location_channel_id,
    };
    notify_answered(&state, &server_id, &answered, &event, now).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RsvpBody {
    /// "interested", "going", "not_going", or null to take the answer back.
    #[serde(default)]
    pub status: Option<String>,
}

/// POST /servers/{server_id}/events/{event_id}/rsvp — answer Interested, Going or Can't go
/// (`{"status": …}`; null takes it back). With an empty body, as desktop 0.3.x sends it,
/// it toggles Going.
pub async fn rsvp_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<StatusCode, ApiError> {
    require_member(&state, &server_id, &auth.0).await?;
    // The event must belong to the space in the path: membership alone doesn't scope it.
    let cancelled: Option<Option<i64>> =
        sqlx::query_scalar("SELECT cancelled_at FROM events WHERE id = ? AND server_id = ?")
            .bind(&event_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    match cancelled {
        None => return Err((StatusCode::NOT_FOUND, "event not found".into())),
        Some(Some(_)) => return Err((StatusCode::CONFLICT, "this event was cancelled".into())),
        Some(None) => {}
    }
    // Older apps send no body, some with a JSON content type: read it by hand.
    let body: Option<RsvpBody> = if body.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        Some(serde_json::from_slice(&body).map_err(|_| bad("send {\"status\": …}"))?)
    };
    let status = match body {
        Some(RsvpBody { status }) => {
            if let Some(s) = status.as_deref() {
                if !STATUSES.contains(&s) {
                    return Err(bad("answer interested, going or not_going"));
                }
            }
            status
        }
        None => {
            let current: Option<String> = sqlx::query_scalar(
                "SELECT status FROM event_rsvps WHERE event_id = ? AND user_id = ?",
            )
            .bind(&event_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
            (current.as_deref() != Some("going")).then(|| "going".to_owned())
        }
    };
    check_rate(&state, "event-answers", &auth.0, ANSWERS_PER_MINUTE)?;
    let written = match status {
        Some(status) => {
            sqlx::query(
                "INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?,?,?)
             ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status",
            )
            .bind(&event_id)
            .bind(&auth.0)
            .bind(status)
            .execute(&state.db)
            .await
        }
        None => {
            sqlx::query("DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?")
                .bind(&event_id)
                .bind(&auth.0)
                .execute(&state.db)
                .await
        }
    };
    written.map_err(crate::api::error::internal)?;
    events_changed(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/{server_id}/events/{event_id} — the host or a manager removes it.
pub async fn delete_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    load_for_host(&state, &server_id, &event_id, &auth.0).await?;
    sqlx::query("DELETE FROM events WHERE id = ?")
        .bind(&event_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    events_changed(&state, &server_id).await;
    Ok(StatusCode::NO_CONTENT)
}
