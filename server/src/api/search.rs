//! Server-scoped message search. Uses Meilisearch when enabled, otherwise falls
//! back to the existing SQL `LIKE` query — the client contract is identical
//! either way (`GET /servers/{server_id}/search?q=…`).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::messages::{self, build_full, SearchQuery},
    auth::AuthUser,
    types::{Message, MessageWithAuthor},
    AppState,
};

pub async fn search_messages(
    auth: AuthUser,
    Path(server_id): Path<String>,
    Query(query): Query<SearchQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MessageWithAuthor>>, (StatusCode, String)> {
    // Membership gate (same as the LIKE handler).
    let member: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
            .bind(&server_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if member.is_none() {
        return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
    }

    let term = query.q.trim().to_owned();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }

    if crate::search::search_enabled() {
        if let Some(ids) = crate::search::search_ids(&server_id, &term, 50).await {
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                // Re-load + scope-check against the live DB so a stale index entry
                // (moved/deleted message) can never leak across servers.
                let msg: Option<Message> = sqlx::query_as(
                    "SELECT m.* FROM messages m
                     JOIN channels c ON c.id = m.channel_id
                     WHERE m.id = ? AND c.server_id = ?",
                )
                .bind(&id)
                .bind(&server_id)
                .fetch_optional(&state.db)
                .await
                .map_err(crate::api::error::internal)?;
                if let Some(msg) = msg {
                    if messages::user_can_access(&state, &msg.channel_id, &auth.0).await {
                        out.push(build_full(&state, msg, &auth.0).await?);
                    }
                }
            }
            return Ok(Json(out));
        }
        // Meilisearch errored — fall through to the SQL path below.
    }

    // Fallback: the existing LIKE search (also used when search is disabled).
    messages::search_messages(
        auth,
        Path(server_id),
        Query(SearchQuery { q: term }),
        State(state),
    )
    .await
}
