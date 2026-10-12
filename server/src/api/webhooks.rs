//! Incoming webhooks: a secret URL another service posts to, and the message appears in a
//! space's text channel under the webhook's name, marked as an app (like Discord's).
//!
//! - Only people who can manage the space's channels make, list, rename, re-picture, renew
//!   or delete them, and only text channels in spaces take them: DMs and group chats are
//!   end-to-end encrypted, and voice channels and threads have no use for them.
//! - The URL's token is 256 bits from the OS's random source, shown once when it's made or
//!   renewed; only its SHA-256 is stored, and it's compared in constant time. A wrong id and
//!   a wrong token get the same 404.
//! - Posting needs no account, so it's limited per address (before anything is looked up)
//!   and per webhook (after the token checks out, so strangers can't use up its budget), and
//!   the body is capped at [`MAX_BODY_BYTES`].
//! - Each webhook posts as its own account row (`users.is_bot`), so its messages flow
//!   through the ordinary message path and keep their author after the webhook is deleted.
//!   That account can't sign in and isn't found, messaged or befriended. A post's
//!   `username`/`avatar_url` are ignored, so a webhook can't pose as a person, and
//!   `@everyone`/`@here` keep their words but ping nobody.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix, User},
    AppState,
};

/// The largest request body a post may have; the message itself keeps the usual limit.
pub const MAX_BODY_BYTES: usize = 16 * 1024;
/// A webhook's name, in characters (Discord's limit).
const NAME_MAX_CHARS: usize = 80;
/// Webhooks per channel.
const PER_CHANNEL: i64 = 10;
/// Secret token length in bytes (256 bits).
const TOKEN_BYTES: usize = 32;
/// Posts per webhook: a short burst, and a steady rate.
const BURST: usize = 5;
const BURST_WINDOW: Duration = Duration::from_secs(2);
const PER_MINUTE: usize = 30;
/// Posts per client address across every webhook, counted before any lookup.
const PER_ADDRESS_PER_MINUTE: usize = 120;
/// Webhook changes (make, rename, renew, delete) per account per minute.
const CHANGES_PER_MINUTE: usize = 20;
const MINUTE: Duration = Duration::from_secs(60);

type ApiError = (StatusCode, String);

fn bad(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

fn forbidden() -> ApiError {
    (
        StatusCode::FORBIDDEN,
        "only people who can manage this space's channels can do that".into(),
    )
}

/// The one answer for a URL that doesn't work, whichever part of it is wrong.
fn unknown_webhook() -> ApiError {
    (StatusCode::NOT_FOUND, "unknown webhook".into())
}

/// A webhook as its managers see it. The token is never part of it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Webhook {
    pub id: String,
    pub channel_id: String,
    pub server_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub created_by: Option<String>,
    pub created_at: i64,
}

/// A webhook with its URL, returned once when it's made or its URL is renewed.
#[derive(Debug, Serialize)]
pub struct WebhookWithToken {
    #[serde(flatten)]
    pub webhook: Webhook,
    pub token: String,
    pub url: String,
}

const WEBHOOK_COLUMNS: &str =
    "w.id, w.channel_id, w.server_id, w.name, u.avatar_url, w.created_by, w.created_at
     FROM webhooks w JOIN users u ON u.id = w.bot_user_id";

fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// Equal without an early exit, so the time taken says nothing about how much matched.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The URL to post to: absolute where the server knows its public address.
fn post_url(id: &str, token: &str) -> String {
    let path = format!("/api/v1/webhooks/{id}/{token}");
    match std::env::var("PUBLIC_BASE_URL") {
        Ok(base) if !base.trim().is_empty() => format!("{}{path}", base.trim_end_matches('/')),
        _ => path,
    }
}

fn valid_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(bad("a webhook needs a name"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(bad("a webhook's name can be up to 80 characters"));
    }
    Ok(name.to_owned())
}

/// "@everyone" and "@here" from a webhook keep their words but ping nobody: a zero-width
/// space after the "@" stops them reading as mentions, here and in the app. Like a mention,
/// it only counts where the "@" starts a word, so an address like me@here.com is left alone.
pub fn defuse_mass_mentions(content: &str) -> String {
    let mut out = String::with_capacity(content.len() + 8);
    let mut previous: Option<char> = None;
    for (i, ch) in content.char_indices() {
        out.push(ch);
        if ch == '@' && previous.is_none_or(char::is_whitespace) {
            let rest = &content[i + 1..];
            let names_everyone = rest
                .get(..8)
                .is_some_and(|w| w.eq_ignore_ascii_case("everyone"));
            let names_here = rest
                .get(..4)
                .is_some_and(|w| w.eq_ignore_ascii_case("here"));
            if names_everyone || names_here {
                out.push('\u{200B}');
            }
        }
        previous = Some(ch);
    }
    out
}

async fn can_manage(state: &AppState, server_id: &str, user_id: &str) -> bool {
    crate::api::roles::has_perm(
        state,
        server_id,
        user_id,
        crate::api::roles::perm::MANAGE_CHANNELS,
    )
    .await
}

/// The space of a channel that can take webhooks, once the caller may manage them there.
async fn manageable_channel(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<String, ApiError> {
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT server_id, channel_type, parent_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let Some((server_id, channel_type, parent_id)) = row else {
        return Err((StatusCode::NOT_FOUND, "no such channel".into()));
    };
    let Some(server_id) = server_id else {
        return Err(bad(
            "webhooks are for text channels in spaces; DMs and group chats are end-to-end encrypted",
        ));
    };
    if !can_manage(state, &server_id, user_id).await {
        return Err(forbidden());
    }
    if channel_type != "text" || parent_id.is_some() {
        return Err(bad("webhooks are for text channels in spaces"));
    }
    Ok(server_id)
}

async fn load(state: &AppState, id: &str) -> Result<Option<Webhook>, ApiError> {
    sqlx::query_as(&format!("SELECT {WEBHOOK_COLUMNS} WHERE w.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)
}

/// A webhook the caller may change; 404 when there is none, 403 when they may not.
async fn managed(state: &AppState, id: &str, user_id: &str) -> Result<Webhook, ApiError> {
    let hook = load(state, id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "no such webhook".into()))?;
    if !can_manage(state, &hook.server_id, user_id).await {
        return Err(forbidden());
    }
    Ok(hook)
}

fn changes_allowed(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.rate.check(
        &format!("webhook-change:{user_id}"),
        CHANGES_PER_MINUTE,
        MINUTE,
    ) {
        Ok(())
    } else {
        Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()))
    }
}

/// GET /channels/{channel_id}/webhooks — the channel's webhooks, oldest first.
pub async fn list_webhooks(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<Webhook>>, ApiError> {
    manageable_channel(&state, &channel_id, &auth.0).await?;
    let hooks: Vec<Webhook> = sqlx::query_as(&format!(
        "SELECT {WEBHOOK_COLUMNS} WHERE w.channel_id = ? ORDER BY w.created_at, w.id"
    ))
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(hooks))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: String,
}

/// POST /channels/{channel_id}/webhooks — make a webhook; its URL is in the answer, once.
pub async fn create_webhook(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<Json<WebhookWithToken>, ApiError> {
    let server_id = manageable_channel(&state, &channel_id, &auth.0).await?;
    let name = valid_name(&body.name)?;
    changes_allowed(&state, &auth.0)?;

    let id = new_id();
    let bot_id = new_id();
    let token = new_token();
    let now = now_unix();
    // Count and insert under one write lock, so two at once can't pass the limit together.
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(crate::api::error::internal)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhooks WHERE channel_id = ?")
        .bind(&channel_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    if count >= PER_CHANNEL {
        return Err(bad("a channel can have up to 10 webhooks"));
    }
    // The account its messages are posted as. "~" can't be in a username a person picks,
    // and "!" is no password hash, so nothing can sign in as it.
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, created_at, is_bot)
         VALUES (?, ?, ?, '!', ?, 1)",
    )
    .bind(&bot_id)
    .bind(format!("~webhook-{id}"))
    .bind(&name)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    sqlx::query(
        "INSERT INTO webhooks (id, channel_id, server_id, bot_user_id, name, token_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&channel_id)
    .bind(&server_id)
    .bind(&bot_id)
    .bind(&name)
    .bind(hash_token(&token))
    .bind(&auth.0)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    tx.commit().await.map_err(crate::api::error::internal)?;
    tracing::info!(webhook = %id, channel = %channel_id, "webhook created");

    let webhook = load(&state, &id)
        .await?
        .ok_or_else(|| crate::api::error::internal("webhook vanished"))?;
    let url = post_url(&id, &token);
    Ok(Json(WebhookWithToken {
        webhook,
        token,
        url,
    }))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    #[serde(default)]
    pub name: Option<String>,
    /// An image the caller uploaded (POST /upload), to use as the webhook's picture.
    #[serde(default)]
    pub avatar_file_id: Option<String>,
}

/// PATCH /webhooks/{id} — rename it or change its picture. Its past messages show the new
/// name and picture too, since they're posted as the webhook's account.
pub async fn update_webhook(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Webhook>, ApiError> {
    managed(&state, &id, &auth.0).await?;
    changes_allowed(&state, &auth.0)?;
    let name = body.name.as_deref().map(valid_name).transpose()?;
    let avatar_url = match &body.avatar_file_id {
        None => None,
        Some(file_id) => {
            // Like a profile picture: a real image, uploaded by the caller.
            let content_type: Option<String> = sqlx::query_scalar(
                "SELECT content_type FROM files WHERE id = ? AND uploader_id = ?",
            )
            .bind(file_id)
            .bind(&auth.0)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
            let Some(content_type) = content_type else {
                return Err((StatusCode::NOT_FOUND, "File not found".into()));
            };
            if !content_type.starts_with("image/") {
                return Err(bad("a webhook's picture must be an image"));
            }
            Some(crate::signed_file_url(&crate::public_base_url(), file_id))
        }
    };

    let bot_id: String = sqlx::query_scalar("SELECT bot_user_id FROM webhooks WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if let Some(name) = &name {
        sqlx::query("UPDATE webhooks SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&id)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ? AND is_bot = 1")
            .bind(name)
            .bind(&bot_id)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    }
    if let Some(url) = &avatar_url {
        sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ? AND is_bot = 1")
            .bind(url)
            .bind(&bot_id)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    }
    let hook = load(&state, &id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "no such webhook".into()))?;
    Ok(Json(hook))
}

/// POST /webhooks/{id}/token — a new URL; the old one stops working at once.
pub async fn renew_token(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<WebhookWithToken>, ApiError> {
    let webhook = managed(&state, &id, &auth.0).await?;
    changes_allowed(&state, &auth.0)?;
    let token = new_token();
    sqlx::query("UPDATE webhooks SET token_hash = ? WHERE id = ?")
        .bind(hash_token(&token))
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    tracing::info!(webhook = %id, "webhook URL renewed");
    let url = post_url(&id, &token);
    Ok(Json(WebhookWithToken {
        webhook,
        token,
        url,
    }))
}

/// DELETE /webhooks/{id} — its URL stops working; the messages it posted stay, under its name.
pub async fn delete_webhook(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    managed(&state, &id, &auth.0).await?;
    changes_allowed(&state, &auth.0)?;
    sqlx::query("DELETE FROM webhooks WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    tracing::info!(webhook = %id, "webhook deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// What another service posts: Discord's `content` or Slack's `text`. Anything else in the
/// body (a `username` or `avatar_url` override, embeds) is ignored.
#[derive(Deserialize)]
struct PostBody {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
pub struct PostQuery {
    #[serde(default)]
    pub wait: Option<bool>,
}

/// POST /webhooks/{id}/{token} — no account: post `{"content": …}` and it appears in the
/// channel. 204, or 200 with the message for `?wait=true`.
pub async fn post_message(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((id, token)): Path<(String, String)>,
    Query(query): Query<PostQuery>,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !crate::api::auth::check_client_rate(
        &state,
        &headers,
        &addr,
        "webhook-post",
        PER_ADDRESS_PER_MINUTE,
        MINUTE,
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "slow down".into()));
    }
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT channel_id, bot_user_id, token_hash FROM webhooks WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    let Some((channel_id, bot_id, token_hash)) = row else {
        return Err(unknown_webhook());
    };
    if !same(&hash_token(&token), &token_hash) {
        return Err(unknown_webhook());
    }
    // Counted only once the token checks out, so strangers can't use up its budget.
    if !state
        .rate
        .check_unauth(&format!("webhook-burst:{id}"), BURST, BURST_WINDOW)
        || !state
            .rate
            .check_unauth(&format!("webhook-minute:{id}"), PER_MINUTE, MINUTE)
    {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "this webhook is posting too fast".into(),
        ));
    }

    let post: PostBody = serde_json::from_slice(&body)
        .map_err(|_| bad("the body must be JSON like {\"content\": \"…\"}"))?;
    let content = post
        .content
        .filter(|c| !c.trim().is_empty())
        .or(post.text)
        .unwrap_or_default();
    let content = content.trim();
    if content.is_empty() {
        return Err(bad("content is required"));
    }
    if content.len() > crate::api::messages::MAX_MESSAGE_BYTES {
        return Err(bad("message too long (max 4000 chars)"));
    }
    let content = defuse_mass_mentions(content);

    let author: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&bot_id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let msg =
        crate::api::messages::deliver_message(&state, author, channel_id, content, None, None)
            .await?;
    if query.wait.unwrap_or(false) {
        Ok(Json(msg).into_response())
    } else {
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}

/// Not built yet.
pub async fn sweep_orphan_accounts(_state: &AppState) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mass_mentions_keep_their_words_but_mention_nobody() {
        let out = defuse_mass_mentions("@everyone and @Here, mail me@here.com, @hero, @bob");
        assert!(out.contains("everyone") && out.contains("Here"));
        assert!(!crate::api::notifications::mentions(&out, "nobody"));
        assert!(
            out.contains("me@here.com"),
            "an email address is left alone"
        );
        assert!(out.contains("@hero"), "other names are left alone");
        assert!(
            crate::api::notifications::mentions(&out, "bob"),
            "a person can still be mentioned"
        );
    }

    #[test]
    fn invisible_characters_before_the_at_sign_change_nothing() {
        for raw in [
            "\u{FEFF}@everyone",
            "\u{200B}@here",
            "\u{2060}@everyone",
            "x@here",
        ] {
            let out = defuse_mass_mentions(raw);
            assert!(out.contains("@\u{200B}"), "{raw:?} is defused: {out:?}");
        }
    }

    #[test]
    fn tokens_are_long_random_and_compared_whole() {
        let a = new_token();
        let b = new_token();
        assert!(a.len() >= 43, "256 bits in base64url: {}", a.len());
        assert_ne!(a, b);
        assert!(same(&hash_token(&a), &hash_token(&a)));
        assert!(!same(&hash_token(&a), &hash_token(&b)));
        assert!(!same("abc", "abcd"));
    }
}
