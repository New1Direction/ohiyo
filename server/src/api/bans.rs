//! Bans with a reason, optionally taking the person's recent messages with them, and the
//! space's ban list.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::moderation::{clean_reason, optional_json},
    api::roles::{self, perm},
    auth::AuthUser,
    types::{now_unix, PublicUser, User},
    AppState,
};

type ApiError = (StatusCode, String);

/// How far back a ban may delete the person's messages (0 = none).
pub const BAN_DELETE_SECONDS: [i64; 4] = [0, 3_600, 86_400, 604_800];

#[derive(Deserialize, Default)]
pub struct BanBody {
    #[serde(default)]
    pub reason: Option<String>,
    /// Delete the person's messages in the space from this many seconds back (0 = none).
    #[serde(default)]
    pub delete_message_seconds: Option<i64>,
}

/// The checked options of a ban.
pub struct BanOptions {
    pub reason: Option<String>,
    pub delete_message_seconds: i64,
}

pub fn ban_options(body: &Bytes) -> Result<BanOptions, ApiError> {
    let body: BanBody = optional_json(body)?;
    let delete_message_seconds = body.delete_message_seconds.unwrap_or(0);
    if !BAN_DELETE_SECONDS.contains(&delete_message_seconds) {
        return Err((
            StatusCode::BAD_REQUEST,
            "a ban can delete the last hour, day or week of messages, or none".into(),
        ));
    }
    Ok(BanOptions {
        reason: clean_reason(body.reason)?,
        delete_message_seconds,
    })
}

/// Delete `user_id`'s messages from the last `seconds` in every channel and thread of
/// `server_id`, a batch at a time, freeing their files and telling everyone as a normal
/// delete would.
pub async fn delete_recent_messages(
    state: &AppState,
    server_id: &str,
    user_id: &str,
    seconds: i64,
) {
    if seconds <= 0 {
        return;
    }
    let since = now_unix() - seconds;
    loop {
        let batch: Vec<crate::types::Message> = match sqlx::query_as(
            "SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
             WHERE c.server_id = ? AND m.author_id = ? AND m.created_at >= ?
             LIMIT 100",
        )
        .bind(server_id)
        .bind(user_id)
        .bind(since)
        .fetch_all(&state.db)
        .await
        {
            Ok(batch) => batch,
            Err(e) => {
                tracing::warn!("ban: couldn't list recent messages in {server_id}: {e}");
                return;
            }
        };
        if batch.is_empty() {
            return;
        }
        for message in &batch {
            if let Err(e) = crate::api::messages::delete_message_everywhere(state, message).await {
                tracing::warn!("ban: couldn't delete message {}: {e}", message.id);
                return;
            }
        }
    }
}

#[derive(sqlx::FromRow)]
struct BanRow {
    user_id: String,
    banned_by: Option<String>,
    banned_by_name: Option<String>,
    reason: Option<String>,
    banned_at: i64,
}

#[derive(Serialize)]
pub struct BanEntry {
    pub user: PublicUser,
    pub banned_by: Option<String>,
    pub banned_by_name: Option<String>,
    pub reason: Option<String>,
    pub banned_at: i64,
}

/// GET /servers/{server_id}/bans — who is banned, by whom, when and why.
pub async fn list_bans(
    auth: AuthUser,
    Path(server_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<BanEntry>>, ApiError> {
    let permissions = roles::member_permissions(&state, &server_id, &auth.0).await;
    if permissions & (perm::BAN_MEMBERS | perm::ADMINISTRATOR) == 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "you don't have permission for that".into(),
        ));
    }
    let rows: Vec<BanRow> = sqlx::query_as(
        "SELECT b.user_id, b.banned_by, m.display_name AS banned_by_name, b.reason, b.banned_at
         FROM server_bans b LEFT JOIN users m ON m.id = b.banned_by
         WHERE b.server_id = ? ORDER BY b.banned_at DESC LIMIT 500",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let user: Option<User> = sqlx::query_as("SELECT * FROM users WHERE id = ?")
            .bind(&row.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
        let Some(user) = user else { continue };
        out.push(BanEntry {
            user: PublicUser::from(user),
            banned_by: row.banned_by,
            banned_by_name: row.banned_by_name,
            reason: row.reason,
            banned_at: row.banned_at,
        });
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_body_means_no_options() {
        let options = ban_options(&Bytes::new()).unwrap();
        assert_eq!(options.delete_message_seconds, 0);
        assert!(options.reason.is_none());
        let options = ban_options(&Bytes::from_static(b"  \n")).unwrap();
        assert_eq!(options.delete_message_seconds, 0);
    }

    #[test]
    fn a_ban_only_deletes_back_an_offered_length() {
        assert!(ban_options(&Bytes::from_static(br#"{"delete_message_seconds":5}"#)).is_err());
        let options = ban_options(&Bytes::from_static(
            br#"{"delete_message_seconds":86400,"reason":"  spam  "}"#,
        ))
        .unwrap();
        assert_eq!(options.delete_message_seconds, 86_400);
        assert_eq!(options.reason.as_deref(), Some("spam"));
    }
}
