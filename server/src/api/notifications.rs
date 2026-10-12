//! Notification settings, like Discord's. A space notifies for every message, only for
//! @mentions, or not at all; a space, a channel, a DM or a group chat can be muted for a
//! while or until it's turned back on. They're kept per account so every device follows
//! them, and the push relay obeys them, so a muted chat doesn't wake a phone.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_user,
    types::{now_unix, GatewayEvent, NotificationSetting},
    AppState,
};

/// The shortest and longest mutes: from a minute to a year.
const MIN_MUTE_SECS: i64 = 60;
const MAX_MUTE_SECS: i64 = 366 * 24 * 60 * 60;
/// Setting changes per account per minute; plenty for a person, little for a script.
const WRITES_PER_MINUTE: usize = 60;

#[derive(Deserialize)]
pub struct SetBody {
    /// A space's level: "all", "mentions" or "nothing". Absent or null is the default.
    #[serde(default)]
    pub level: Option<String>,
    pub muted: bool,
    /// How long the mute lasts. Absent or null while muted: until it's turned back on.
    #[serde(default)]
    pub mute_seconds: Option<i64>,
}

type ApiError = (StatusCode, String);

fn bad(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

/// GET /users/@me/notification-settings — the account's settings that differ from the
/// defaults, with any mute that has run out already cleared.
pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<NotificationSetting>>, ApiError> {
    Ok(Json(
        settings_for_user(&state, &auth.0)
            .await
            .map_err(crate::api::error::internal)?,
    ))
}

/// The account's settings that differ from the defaults, as they stand now.
pub async fn settings_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<NotificationSetting>, sqlx::Error> {
    let now = now_unix();
    let rows: Vec<NotificationSetting> = sqlx::query_as(
        "SELECT target_type, target_id, level, muted, muted_until
           FROM notification_settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|setting| setting.as_of(now))
        .filter(|setting| !setting.is_default())
        .collect())
}

/// PUT /users/@me/notification-settings/{target_type}/{target_id} — replace one setting.
/// Going back to the defaults removes it. The server works out when a mute ends, so a
/// device with a wrong clock can't stretch or shorten it.
pub async fn set(
    auth: AuthUser,
    Path((target_type, target_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(body): Json<SetBody>,
) -> Result<Json<NotificationSetting>, ApiError> {
    if !matches!(target_type.as_str(), "server" | "channel") {
        return Err(bad("notification settings are for spaces and channels"));
    }
    if let Some(level) = body.level.as_deref() {
        if !matches!(level, "all" | "mentions" | "nothing") {
            return Err(bad("level must be all, mentions or nothing"));
        }
        if target_type == "channel" {
            return Err(bad("a level is set per space; a channel can be muted"));
        }
    }
    let mute_seconds = if body.muted { body.mute_seconds } else { None };
    if mute_seconds.is_some_and(|secs| !(MIN_MUTE_SECS..=MAX_MUTE_SECS).contains(&secs)) {
        return Err(bad("a mute lasts from a minute to a year"));
    }
    if !state.rate.check(
        &format!("notification-settings:{}", auth.0),
        WRITES_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "slow down — try again in a minute".into(),
        ));
    }
    if !can_see(&state, &auth.0, &target_type, &target_id).await {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    }

    let now = now_unix();
    let setting = NotificationSetting {
        target_type,
        target_id,
        level: body.level.filter(|level| level != "all"),
        muted: body.muted,
        muted_until: mute_seconds.map(|secs| now + secs),
    };
    if setting.is_default() {
        sqlx::query(
            "DELETE FROM notification_settings
              WHERE user_id = ? AND target_type = ? AND target_id = ?",
        )
        .bind(&auth.0)
        .bind(&setting.target_type)
        .bind(&setting.target_id)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    } else {
        sqlx::query(
            "INSERT INTO notification_settings
                 (user_id, target_type, target_id, level, muted, muted_until, updated_at)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
                 level = excluded.level, muted = excluded.muted,
                 muted_until = excluded.muted_until, updated_at = excluded.updated_at",
        )
        .bind(&auth.0)
        .bind(&setting.target_type)
        .bind(&setting.target_id)
        .bind(&setting.level)
        .bind(setting.muted)
        .bind(setting.muted_until)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    }

    broadcast_to_user(
        &state.sessions,
        &auth.0,
        &GatewayEvent::NotificationSettingsUpdate(setting.clone()),
    );
    Ok(Json(setting))
}

/// A space the account is in, or a channel, DM or group chat it can see.
async fn can_see(state: &AppState, user_id: &str, target_type: &str, target_id: &str) -> bool {
    if target_type == "channel" {
        return crate::api::messages::user_can_access(state, target_id, user_id).await;
    }
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
        .bind(target_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Whether a new message should wake a member's phone. A muted DM or group chat is silent.
/// In a space, "Nothing" is silent, an @mention gets through a mute (as in Discord), a
/// muted space or channel is otherwise silent, and "Only @mentions" wants a mention.
/// The app applies the same rule to its own notifications (client/src/lib/notificationSettings.ts).
pub fn should_push(
    in_space: bool,
    mentioned: bool,
    space: Option<&NotificationSetting>,
    channel: Option<&NotificationSetting>,
    now: i64,
) -> bool {
    let channel_muted = channel.is_some_and(|c| c.is_muted(now));
    if !in_space {
        return !channel_muted;
    }
    let level = space.and_then(|s| s.level.as_deref()).unwrap_or("all");
    if level == "nothing" {
        return false;
    }
    if mentioned {
        return true;
    }
    if channel_muted || space.is_some_and(|s| s.is_muted(now)) {
        return false;
    }
    level == "all"
}

/// True if `content` mentions `username` as a whole `@name`, or says @everyone or @here.
/// Same rule as the app's (client/src/lib/mentions.ts): the `@` starts the text or follows
/// whitespace, the name matches in any case, and no letter, digit or `_` follows it.
pub fn mentions(content: &str, username: &str) -> bool {
    ["everyone", "here", username]
        .iter()
        .filter(|name| !name.is_empty())
        .any(|name| mentions_name(content, name))
}

fn mentions_name(content: &str, name: &str) -> bool {
    let name = name.to_lowercase();
    let content = content.to_lowercase();
    let mut from = 0;
    while let Some(found) = content[from..].find('@') {
        let at = from + found;
        let starts_word = content[..at]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let rest = &content[at + 1..];
        if starts_word && rest.starts_with(&name) {
            let next = rest[name.len()..].chars().next();
            if !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                return true;
            }
        }
        from = at + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn space(level: Option<&str>, muted: bool) -> NotificationSetting {
        NotificationSetting {
            target_type: "server".into(),
            target_id: "s".into(),
            level: level.map(str::to_owned),
            muted,
            muted_until: None,
        }
    }

    fn channel(muted: bool, muted_until: Option<i64>) -> NotificationSetting {
        NotificationSetting {
            target_type: "channel".into(),
            target_id: "c".into(),
            level: None,
            muted,
            muted_until,
        }
    }

    #[test]
    fn with_no_settings_every_message_pushes() {
        assert!(should_push(true, false, None, None, NOW));
        assert!(should_push(false, false, None, None, NOW));
    }

    #[test]
    fn a_muted_dm_never_pushes() {
        let muted = channel(true, None);
        assert!(!should_push(false, false, None, Some(&muted), NOW));
        assert!(!should_push(false, true, None, Some(&muted), NOW));
    }

    #[test]
    fn a_mention_gets_through_a_mute_but_not_nothing() {
        let muted_channel = channel(true, None);
        let muted_space = space(None, true);
        assert!(!should_push(true, false, None, Some(&muted_channel), NOW));
        assert!(should_push(true, true, None, Some(&muted_channel), NOW));
        assert!(!should_push(true, false, Some(&muted_space), None, NOW));
        assert!(should_push(true, true, Some(&muted_space), None, NOW));
        let nothing = space(Some("nothing"), false);
        assert!(!should_push(true, true, Some(&nothing), None, NOW));
    }

    #[test]
    fn only_mentions_wants_a_mention() {
        let mentions_only = space(Some("mentions"), false);
        assert!(!should_push(true, false, Some(&mentions_only), None, NOW));
        assert!(should_push(true, true, Some(&mentions_only), None, NOW));
    }

    #[test]
    fn an_ended_mute_is_over() {
        let ended = channel(true, Some(NOW - 1));
        assert!(should_push(true, false, None, Some(&ended), NOW));
        assert!(!ended.is_muted(NOW));
        assert!(ended.as_of(NOW).is_default());
        assert!(channel(true, Some(NOW + 1)).is_muted(NOW));
    }

    #[test]
    fn mentions_are_whole_names_in_any_case() {
        assert!(mentions("hey @Sam look", "sam"));
        assert!(mentions("@sam", "sam"));
        assert!(mentions("ok\n@sam!", "sam"));
        assert!(mentions("@everyone meeting", "sam"));
        assert!(mentions("ping @HERE", "sam"));
        assert!(
            !mentions("@samantha hi", "sam"),
            "another name that starts the same"
        );
        assert!(!mentions("@sam_2 hi", "sam"));
        assert!(!mentions("mail sam@example.com", "sam"), "an email address");
        assert!(!mentions("no mention", "sam"));
        assert!(mentions("hi @john.doe", "john.doe"), "names with dots");
        assert!(!mentions("hi @john", "john.doe"));
    }

    /// The cases the app is checked against too (client/test/mentions.test.ts), so the push
    /// relay and the app agree on whom a message mentions.
    #[test]
    fn mentions_agree_with_the_app() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../client/test/fixtures/mention-cases.json"
        ))
        .unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let content = case["content"].as_str().unwrap();
            let name = case["name"].as_str().unwrap();
            assert_eq!(
                mentions(content, name),
                case["mentions"].as_bool().unwrap(),
                "{}: {content:?} for {name}",
                case["why"]
            );
        }
    }
}
