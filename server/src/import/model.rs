//! The importer's stable input contract. Phase 2's discrawl reader produces these;
//! Phase 1's mapper consumes them — so all mapping logic is decoupled from discrawl's
//! actual SQLite schema.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAuthor {
    pub discord_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRole {
    pub discord_id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCategory {
    pub discord_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceChannel {
    pub discord_id: String,
    pub name: String,
    /// Normalized: "voice" maps to an Ohiyo voice channel; everything else to "text".
    pub kind: String,
    pub topic: Option<String>,
    pub position: i64,
    pub category_discord_id: Option<String>,
    /// Messages in CHRONOLOGICAL (oldest-first) order, so reply targets are mapped
    /// before the messages that quote them.
    pub messages: Vec<SourceMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAttachment {
    pub discord_id: String,
    pub filename: String,
    pub content_type: String,
    /// Local path where discrawl downloaded the file (Phase 2 supplies a real path;
    /// Phase 1 tests supply a temp file).
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReaction {
    /// The reacting member's snowflake. Per-user (not just a count), so reactions map
    /// to real ghost authors. If the source only has counts, the reader yields none.
    pub user_discord_id: String,
    pub emoji: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMessage {
    pub discord_id: String,
    pub author_discord_id: String,
    pub content: String,
    pub created_at: i64,
    pub reply_to_discord_id: Option<String>,
    pub pinned: bool,
    pub attachments: Vec<SourceAttachment>,
    pub reactions: Vec<SourceReaction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceGuild {
    pub discord_id: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub authors: Vec<SourceAuthor>,
    pub roles: Vec<SourceRole>,
    pub categories: Vec<SourceCategory>,
    pub channels: Vec<SourceChannel>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum HistoryWindow {
    All,
    Last90Days,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ImportOptions {
    pub history: HistoryWindow,
}

const NINETY_DAYS_SECS: i64 = 90 * 24 * 60 * 60;

/// True if a message at `created_at` falls inside the selected window.
pub fn within_window(created_at: i64, window: HistoryWindow, now: i64) -> bool {
    match window {
        HistoryWindow::All => true,
        HistoryWindow::Last90Days => created_at >= now - NINETY_DAYS_SECS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_window_keeps_everything() {
        assert!(within_window(0, HistoryWindow::All, 1_000_000_000));
    }

    #[test]
    fn ninety_day_window_filters_old_messages() {
        let now = 1_000_000_000;
        assert!(within_window(now - 10, HistoryWindow::Last90Days, now));
        assert!(!within_window(
            now - NINETY_DAYS_SECS - 1,
            HistoryWindow::Last90Days,
            now
        ));
    }
}
