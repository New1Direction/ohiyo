//! Watch-party snapshot — a client opening a channel fetches the current synced
//! video state here; live play/pause/seek updates ride the gateway WatchUpdate event.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{api::messages::user_can_access, auth::AuthUser, types::WatchSession, AppState};

/// GET /channels/{channel_id}/watch — the active watch session, or null.
pub async fn get_watch(
    auth: AuthUser,
    Path(channel_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Option<WatchSession>>, (StatusCode, String)> {
    if !user_can_access(&state, &channel_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "no access to this channel".into()));
    }
    let session = state.watch.read().unwrap().get(&channel_id).cloned();
    Ok(Json(session))
}
