//! One-click Discord server import (Phase 1: offline core).
//!
//! Maps a stable [`model::SourceGuild`] into a fresh Ohiyo space. All mapping is
//! idempotent and resumable via the `discord_import_map` provenance table, keyed by
//! the source Discord snowflake.

pub mod attachments;
pub mod discrawl;
pub mod mapper;
pub mod model;
pub mod report;

use anyhow::Result;
use sqlx::SqlitePool;

use model::{within_window, ImportOptions, SourceGuild};
use report::ImportReport;

use crate::types::{new_id, now_unix};

pub async fn create_import(
    db: &SqlitePool,
    owner_id: &str,
    guild_id: &str,
    server_id: &str,
) -> Result<String> {
    let id = new_id();
    let now = now_unix();
    sqlx::query(
        "INSERT INTO discord_imports (id, server_id, guild_id, owner_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(server_id)
    .bind(guild_id)
    .bind(owner_id)
    .bind("running")
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(id)
}

pub async fn set_status(db: &SqlitePool, import_id: &str, status: &str) -> Result<()> {
    let result = sqlx::query("UPDATE discord_imports SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_unix())
        .bind(import_id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        anyhow::bail!("import not found: {import_id}");
    }
    Ok(())
}

/// Record a snowflake→Ohiyo mapping. `INSERT OR IGNORE` keeps the FIRST id, so a
/// resumed run that re-maps the same entity is a no-op rather than a conflict.
pub async fn record_map(
    db: &SqlitePool,
    import_id: &str,
    entity_type: &str,
    discord_id: &str,
    ohiyo_id: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO discord_import_map (import_id, entity_type, discord_id, ohiyo_id)
         VALUES (?,?,?,?)",
    )
    .bind(import_id)
    .bind(entity_type)
    .bind(discord_id)
    .bind(ohiyo_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn lookup_map(
    db: &SqlitePool,
    import_id: &str,
    entity_type: &str,
    discord_id: &str,
) -> Result<Option<String>> {
    let id = sqlx::query_scalar(
        "SELECT ohiyo_id FROM discord_import_map
         WHERE import_id = ? AND entity_type = ? AND discord_id = ?",
    )
    .bind(import_id)
    .bind(entity_type)
    .bind(discord_id)
    .fetch_optional(db)
    .await?;
    Ok(id)
}

/// Create a fresh server owned by `owner_id`, then import `guild` into it.
pub async fn run_import(
    db: &SqlitePool,
    owner_id: &str,
    guild: &SourceGuild,
    opts: ImportOptions,
) -> Result<(String, ImportReport)> {
    let server_id = new_id();
    let now = now_unix();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, icon_url, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&server_id)
    .bind(&guild.name)
    .bind(owner_id)
    .bind(&guild.icon_url)
    .bind(now)
    .execute(db)
    .await?;
    sqlx::query("INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)")
        .bind(&server_id)
        .bind(owner_id)
        .bind(now)
        .execute(db)
        .await?;
    let import_id = create_import(db, owner_id, &guild.discord_id, &server_id).await?;
    let report = run_import_into(db, &import_id, &server_id, owner_id, guild, opts, now).await?;
    Ok((server_id, report))
}

/// Resumable core: idempotent over `import_id`, so re-running after a crash continues
/// without duplicating anything.
pub async fn run_import_into(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    owner_id: &str,
    guild: &SourceGuild,
    opts: ImportOptions,
    now: i64,
) -> Result<ImportReport> {
    let mut report = ImportReport::default();

    for author in &guild.authors {
        mapper::map_author(db, import_id, author).await?;
        report.authors += 1;
    }

    for role in &guild.roles {
        mapper::map_role(db, import_id, server_id, role).await?;
        report.flag_role_review(&role.name);
    }

    for category in &guild.categories {
        mapper::map_category(db, import_id, server_id, category).await?;
        report.categories += 1;
    }

    for channel in &guild.channels {
        let channel_id = mapper::map_channel(db, import_id, server_id, channel).await?;
        report.channels += 1;

        for message in &channel.messages {
            if !within_window(message.created_at, opts.history, now) {
                continue;
            }

            let author_id =
                match lookup_map(db, import_id, "user", &message.author_discord_id).await? {
                    Some(id) => id,
                    None => {
                        report.note_parked(&format!(
                            "message {} from unknown author",
                            message.discord_id
                        ));
                        continue;
                    }
                };

            let mut file_ids = Vec::new();
            for attachment in &message.attachments {
                file_ids.push(attachments::rehost(db, import_id, owner_id, attachment).await?);
                report.attachments += 1;
            }
            let attachments_json = if file_ids.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&file_ids)?)
            };

            let message_id = mapper::map_message(
                db,
                import_id,
                &channel_id,
                &author_id,
                message,
                attachments_json.as_deref(),
            )
            .await?;
            report.messages += 1;

            for reaction in &message.reactions {
                if let Some(reactor_id) =
                    lookup_map(db, import_id, "user", &reaction.user_discord_id).await?
                {
                    mapper::map_reaction(db, &message_id, &reactor_id, &reaction.emoji).await?;
                    report.reactions += 1;
                }
            }
        }
    }

    set_status(db, import_id, "complete").await?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Single-connection in-memory DB seeded with an owner user + a server, so the
    /// FK-constrained import rows have valid parents. (Multi-conn `:memory:` hands out
    /// separate empty DBs — see provision/mod.rs test_db for the same constraint.)
    pub(crate) async fn test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, created_at)
             VALUES ('u1','owner','Owner','h',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO servers (id, name, owner_id, created_at) VALUES ('s1','Imported','u1',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn record_then_lookup_returns_the_mapped_id() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "guild-123", "s1").await.unwrap();
        record_map(&db, &import_id, "user", "disc-1", "ohiyo-1")
            .await
            .unwrap();
        let got = lookup_map(&db, &import_id, "user", "disc-1").await.unwrap();
        assert_eq!(got.as_deref(), Some("ohiyo-1"));
    }

    #[tokio::test]
    async fn record_map_is_idempotent_keeping_the_first_id() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        record_map(&db, &import_id, "user", "disc-1", "first")
            .await
            .unwrap();
        record_map(&db, &import_id, "user", "disc-1", "second")
            .await
            .unwrap();
        assert_eq!(
            lookup_map(&db, &import_id, "user", "disc-1")
                .await
                .unwrap()
                .as_deref(),
            Some("first")
        );
    }

    #[tokio::test]
    async fn set_status_succeeds_on_valid_import() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "guild-123", "s1").await.unwrap();
        let result = set_status(&db, &import_id, "complete").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn set_status_errors_on_unknown_import() {
        let db = test_db().await;
        let err = set_status(&db, "does-not-exist", "complete").await;
        assert!(err.is_err());
    }

    fn sample_guild() -> model::SourceGuild {
        use model::*;
        SourceGuild {
            discord_id: "g-1".into(),
            name: "Crew".into(),
            icon_url: None,
            authors: vec![SourceAuthor {
                discord_id: "d-1".into(),
                display_name: "Alice".into(),
                avatar_url: None,
            }],
            roles: vec![SourceRole {
                discord_id: "r-1".into(),
                name: "Mod".into(),
                color: None,
            }],
            categories: vec![SourceCategory {
                discord_id: "c-1".into(),
                name: "Text".into(),
                position: 0,
            }],
            channels: vec![SourceChannel {
                discord_id: "ch-1".into(),
                name: "general".into(),
                kind: "text".into(),
                topic: None,
                position: 0,
                category_discord_id: Some("c-1".into()),
                messages: vec![SourceMessage {
                    discord_id: "m-1".into(),
                    author_discord_id: "d-1".into(),
                    content: "hello".into(),
                    created_at: 1_000,
                    reply_to_discord_id: None,
                    pinned: true,
                    attachments: vec![],
                    reactions: vec![SourceReaction {
                        user_discord_id: "d-1".into(),
                        emoji: "👍".into(),
                    }],
                }],
            }],
        }
    }

    #[tokio::test]
    async fn run_import_populates_a_new_space() {
        let db = test_db().await;
        let opts = model::ImportOptions {
            history: model::HistoryWindow::All,
        };
        let (server_id, report) = run_import(&db, "u1", &sample_guild(), opts).await.unwrap();

        assert_eq!(report.channels, 1);
        assert_eq!(report.messages, 1);
        assert_eq!(report.reactions, 1);
        assert_eq!(report.roles_needing_review, vec!["Mod"]);

        let msg_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id \
             WHERE c.server_id = ?",
        )
        .bind(&server_id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(msg_count, 1);

        let status: String =
            sqlx::query_scalar("SELECT status FROM discord_imports WHERE server_id = ?")
                .bind(&server_id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "complete");
    }

    #[tokio::test]
    async fn resuming_the_same_import_creates_no_duplicates() {
        let db = test_db().await;
        let guild = sample_guild();
        let opts = model::ImportOptions {
            history: model::HistoryWindow::All,
        };

        let (server_id, _) = run_import(&db, "u1", &guild, opts).await.unwrap();
        let import_id: String =
            sqlx::query_scalar("SELECT id FROM discord_imports WHERE server_id = ?")
                .bind(&server_id)
                .fetch_one(&db)
                .await
                .unwrap();
        run_import_into(&db, &import_id, &server_id, "u1", &guild, opts, now_unix())
            .await
            .unwrap();

        let msg_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(msg_count, 1, "re-run must not duplicate messages");
    }

    #[tokio::test]
    async fn ninety_day_window_skips_old_messages() {
        let db = test_db().await;
        let mut guild = sample_guild();
        guild.channels[0].messages[0].created_at = 1;
        let opts = model::ImportOptions {
            history: model::HistoryWindow::Last90Days,
        };
        let (_server_id, report) = run_import(&db, "u1", &guild, opts).await.unwrap();
        assert_eq!(
            report.messages, 0,
            "message older than 90 days must be skipped"
        );
    }
}
