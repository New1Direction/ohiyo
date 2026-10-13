//! Event reminders: 15 minutes before an event and at its start, to each person who said
//! Interested or Going. Run from the background loop; each answer carries a flag per
//! reminder, claimed before sending, so a reminder goes to a person once even across
//! restarts. A space set to Nothing or muted stays silent, and an event in a channel only
//! goes to people who can see that channel. A start reminder that an outage
//! held back by more than ten minutes is dropped rather than sent late.

use crate::{
    api::events::can_see,
    gateway::broadcast_to_user,
    types::{GatewayEvent, NotificationSetting},
    AppState,
};

/// The "starting soon" reminder goes this long before the start.
const SOON_SECS: i64 = 15 * 60;
/// A start reminder this late is no use any more.
const START_GRACE_SECS: i64 = 10 * 60;
/// Reminders per sweep; the rest go on the next one.
const BATCH: i64 = 500;

#[derive(Clone, Copy)]
pub enum Phase {
    Soon,
    Start,
    Cancelled,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Soon => "soon",
            Phase::Start => "start",
            Phase::Cancelled => "cancelled",
        }
    }
}

/// Send what's due at `now`. Errors are logged; the next sweep tries again.
pub async fn send_due_reminders(state: &AppState, now: i64) {
    if let Err(e) = run(state, now).await {
        tracing::warn!("event reminders failed: {e}");
    }
}

async fn run(state: &AppState, now: i64) -> Result<(), sqlx::Error> {
    // Starts an outage made stale: mark them done without a word.
    sqlx::query(
        "UPDATE event_rsvps SET reminded_soon = 1, reminded_start = 1
          WHERE reminded_start = 0
            AND event_id IN (SELECT id FROM events WHERE starts_at <= ?)",
    )
    .bind(now - START_GRACE_SECS)
    .execute(&state.db)
    .await?;
    remind(state, now, Phase::Start).await?;
    remind(state, now, Phase::Soon).await
}

#[derive(sqlx::FromRow)]
struct Due {
    event_id: String,
    user_id: String,
    server_id: String,
    title: String,
    starts_at: i64,
    location_kind: Option<String>,
    location_channel_id: Option<String>,
}

async fn remind(state: &AppState, now: i64, phase: Phase) -> Result<(), sqlx::Error> {
    // Each window is "after `from`, up to and including `to`".
    let (window, from, to, claim) = match phase {
        Phase::Soon => (
            "r.reminded_soon = 0 AND e.starts_at > ? AND e.starts_at <= ?",
            now,
            now + SOON_SECS,
            "UPDATE event_rsvps SET reminded_soon = 1
              WHERE event_id = ? AND user_id = ? AND reminded_soon = 0",
        ),
        Phase::Start => (
            "r.reminded_start = 0 AND e.starts_at > ? AND e.starts_at <= ?",
            now - START_GRACE_SECS,
            now,
            "UPDATE event_rsvps SET reminded_soon = 1, reminded_start = 1
              WHERE event_id = ? AND user_id = ? AND reminded_start = 0",
        ),
        Phase::Cancelled => return Ok(()),
    };
    let sql = format!(
        "SELECT r.event_id, r.user_id, e.server_id, e.title, e.starts_at,
                e.location_kind, e.location_channel_id
           FROM event_rsvps r
           JOIN events e ON e.id = r.event_id
           JOIN server_members m ON m.server_id = e.server_id AND m.user_id = r.user_id
          WHERE e.cancelled_at IS NULL AND r.status IN ('interested', 'going') AND {window}
          ORDER BY e.starts_at
          LIMIT ?"
    );
    let due: Vec<Due> = sqlx::query_as(&sql)
        .bind(from)
        .bind(to)
        .bind(BATCH)
        .fetch_all(&state.db)
        .await?;

    let mut push = Vec::new();
    for row in due {
        // Claim it first: whoever flips the flag sends it, once.
        let claimed = sqlx::query(claim)
            .bind(&row.event_id)
            .bind(&row.user_id)
            .execute(&state.db)
            .await?
            .rows_affected()
            == 1;
        if !claimed
            || silenced(state, &row.user_id, &row.server_id, now).await?
            || !can_see(state, row.location_channel_id.as_deref(), &row.user_id).await
        {
            continue;
        }
        broadcast_to_user(
            &state.sessions,
            &row.user_id,
            &GatewayEvent::EventReminder {
                server_id: row.server_id,
                event_id: row.event_id,
                title: row.title,
                starts_at: row.starts_at,
                phase: phase.as_str().into(),
                location_kind: row.location_kind,
                location_channel_id: row.location_channel_id,
            },
        );
        push.push(row.user_id);
    }
    crate::api::push::queue_event_pushes(state, &push).await;
    Ok(())
}

/// Whether someone set the space to Nothing or muted it.
async fn silenced(
    state: &AppState,
    user_id: &str,
    server_id: &str,
    now: i64,
) -> Result<bool, sqlx::Error> {
    let setting: Option<NotificationSetting> = sqlx::query_as(
        "SELECT target_type, target_id, level, muted, muted_until
           FROM notification_settings
          WHERE user_id = ? AND target_type = 'server' AND target_id = ?",
    )
    .bind(user_id)
    .bind(server_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(setting.is_some_and(|s| s.level.as_deref() == Some("nothing") || s.is_muted(now)))
}

/// Tell people who answered about an event (its cancellation), in the app and on offline
/// phones, minus anyone who silenced the space or can't see the event's channel.
pub async fn notify_answered(
    state: &AppState,
    server_id: &str,
    channel_id: Option<&str>,
    user_ids: &[String],
    event: &GatewayEvent,
    now: i64,
) {
    let mut push = Vec::new();
    for user_id in user_ids {
        match silenced(state, user_id, server_id, now).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("event notice: reading notification settings failed: {e}");
                continue;
            }
        }
        if !can_see(state, channel_id, user_id).await {
            continue;
        }
        broadcast_to_user(&state.sessions, user_id, event);
        push.push(user_id.clone());
    }
    crate::api::push::queue_event_pushes(state, &push).await;
}
