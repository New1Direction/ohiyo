use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_server,
    types::{new_id, now_unix, GatewayEvent},
    AppState,
};

#[derive(Serialize)]
pub struct EventInfo {
    pub id: String,
    pub server_id: String,
    pub title: String,
    pub description: Option<String>,
    pub starts_at: i64,
    pub created_by: String,
    pub rsvp_count: i64,
    pub me_rsvp: bool,
}

async fn is_member(state: &AppState, server_id: &str, user_id: &str) -> bool {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    row.is_some()
}

/// GET /servers/{server_id}/events — upcoming-first list with RSVP info.
pub async fn list_events(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<EventInfo>>, (StatusCode, String)> {
    if !is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let rows: Vec<(String, String, Option<String>, i64, String)> = sqlx::query_as(
        "SELECT id, title, description, starts_at, created_by FROM events
         WHERE server_id = ? ORDER BY starts_at",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, title, description, starts_at, created_by) in rows {
        let rsvp_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM event_rsvps WHERE event_id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0);
        let me: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM event_rsvps WHERE event_id = ? AND user_id = ?",
        )
        .bind(&id)
        .bind(&auth.0)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
        out.push(EventInfo {
            id,
            server_id: server_id.clone(),
            title,
            description,
            starts_at,
            created_by,
            rsvp_count,
            me_rsvp: me > 0,
        });
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CreateEventBody {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub starts_at: i64,
}

/// POST /servers/{server_id}/events — any member can plan an event.
pub async fn create_event(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<CreateEventBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let title = body.title.trim();
    if title.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "give your event a name".into()));
    }
    sqlx::query(
        "INSERT INTO events (id, server_id, title, description, starts_at, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(new_id())
    .bind(&server_id)
    .bind(title)
    .bind(&body.description)
    .bind(body.starts_at)
    .bind(&auth.0)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    broadcast_to_server(
        &state,
        &server_id,
        &GatewayEvent::EventsChanged {
            server_id: server_id.clone(),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /servers/{server_id}/events/{event_id}/rsvp — toggle "I'm in".
pub async fn rsvp_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let had: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?")
            .bind(&event_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    if had.is_some() {
        sqlx::query("DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?")
            .bind(&event_id)
            .bind(&auth.0)
            .execute(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    } else {
        sqlx::query("INSERT OR IGNORE INTO event_rsvps (event_id, user_id) VALUES (?,?)")
            .bind(&event_id)
            .bind(&auth.0)
            .execute(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    broadcast_to_server(
        &state,
        &server_id,
        &GatewayEvent::EventsChanged {
            server_id: server_id.clone(),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/{server_id}/events/{event_id} — creator or owner removes it.
pub async fn delete_event(
    auth: AuthUser,
    Path((server_id, event_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let creator: Option<String> =
        sqlx::query_scalar("SELECT created_by FROM events WHERE id = ? AND server_id = ?")
            .bind(&event_id)
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let creator = creator.ok_or((StatusCode::NOT_FOUND, "event not found".into()))?;

    let is_manager = crate::api::roles::has_perm(
        &state,
        &server_id,
        &auth.0,
        crate::api::roles::perm::MANAGE_SERVER,
    )
    .await;
    if creator != auth.0 && !is_manager {
        return Err((
            StatusCode::FORBIDDEN,
            "only the host or a manager can cancel this".into(),
        ));
    }

    sqlx::query("DELETE FROM events WHERE id = ?")
        .bind(&event_id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    broadcast_to_server(
        &state,
        &server_id,
        &GatewayEvent::EventsChanged {
            server_id: server_id.clone(),
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
