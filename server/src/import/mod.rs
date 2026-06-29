//! One-click Discord server import (Phase 1: offline core).
//!
//! Maps a stable [`model::SourceGuild`] into a fresh Ohiyo space. All mapping is
//! idempotent and resumable via the `discord_import_map` provenance table, keyed by
//! the source Discord snowflake.

pub mod assets;
pub mod attachments;
pub mod discord_template;
pub mod discrawl;
pub mod mapper;
pub mod model;
pub mod report;

use anyhow::Result;
use sqlx::SqlitePool;

use model::{within_window, ImportOptions, SourceEmoji, SourceGuild};
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

    ingest_server_icon(db, import_id, server_id, owner_id, guild).await?;

    for author in &guild.authors {
        mapper::map_author(db, import_id, author).await?;
        report.authors += 1;
    }

    for role in &guild.roles {
        mapper::map_role(db, import_id, server_id, role).await?;
        if role.permissions.is_some() {
            report.flag_role_review(&role.name);
        }
    }

    for emoji in &guild.emojis {
        if ingest_emoji(db, import_id, server_id, owner_id, emoji)
            .await
            .is_ok()
        {
            report.emojis += 1;
        } else {
            report.note_parked(&format!("emoji :{}: could not be imported", emoji.name));
        }
    }

    for category in &guild.categories {
        mapper::map_category(db, import_id, server_id, category).await?;
        report.categories += 1;
        for overwrite in &category.permission_overwrites {
            mapper::record_category_permission_overwrite(db, import_id, category, overwrite)
                .await?;
            report.permission_overwrites += 1;
        }
    }

    for channel in &guild.channels {
        let channel_id = mapper::map_channel(db, import_id, server_id, channel).await?;
        report.channels += 1;
        for overwrite in &channel.permission_overwrites {
            mapper::record_permission_overwrite(db, import_id, channel, overwrite).await?;
            report.permission_overwrites += 1;
        }

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

async fn ingest_server_icon(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    owner_id: &str,
    guild: &SourceGuild,
) -> Result<()> {
    let Some(url) = guild.icon_url.as_deref().filter(|s| s.starts_with("http")) else {
        return Ok(());
    };
    match assets::download_image_to_file(db, owner_id, url, "discord-server-icon").await {
        Ok(asset) => {
            let icon_url = crate::signed_file_url(&crate::public_base_url(), &asset.file_id);
            sqlx::query("UPDATE servers SET icon_url = ? WHERE id = ?")
                .bind(&icon_url)
                .bind(server_id)
                .execute(db)
                .await?;
            mapper::record_asset_map(
                db,
                import_id,
                "server_icon",
                &guild.discord_id,
                Some(&guild.name),
                Some(&asset.file_id),
                Some(url),
                "imported",
                Some(&asset.content_type),
            )
            .await?;
        }
        Err(e) => {
            mapper::record_asset_map(
                db,
                import_id,
                "server_icon",
                &guild.discord_id,
                Some(&guild.name),
                None,
                Some(url),
                "failed",
                Some(&e.to_string()),
            )
            .await?;
        }
    }
    Ok(())
}

async fn ingest_emoji(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    owner_id: &str,
    emoji: &SourceEmoji,
) -> Result<()> {
    let Some(url) = emoji.image_url.as_deref() else {
        mapper::record_asset_map(
            db,
            import_id,
            "emoji",
            &emoji.discord_id,
            Some(&emoji.name),
            None,
            None,
            "missing_url",
            None,
        )
        .await?;
        anyhow::bail!("emoji image URL missing");
    };
    let asset =
        assets::download_image_to_file(db, owner_id, url, &format!("{}.png", emoji.name)).await?;
    let emoji_id = new_id();
    let emoji_name = sanitize_emoji_name(&emoji.name);
    let emoji_url = crate::signed_file_path(&asset.file_id);
    sqlx::query(
        "INSERT OR IGNORE INTO server_emojis (id, server_id, name, file_id, url, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&emoji_id)
    .bind(server_id)
    .bind(&emoji_name)
    .bind(&asset.file_id)
    .bind(&emoji_url)
    .bind(owner_id)
    .bind(now_unix())
    .execute(db)
    .await?;
    mapper::record_asset_map(
        db,
        import_id,
        "emoji",
        &emoji.discord_id,
        Some(&emoji_name),
        Some(&emoji_id),
        Some(url),
        "imported",
        Some(&asset.content_type),
    )
    .await?;
    Ok(())
}

fn sanitize_emoji_name(name: &str) -> String {
    let mut out: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(32)
        .collect();
    if out.len() < 2 {
        out = "emoji".to_owned();
    }
    out
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
                permissions: Some((1u128 << 4).to_string()),
                position: 1,
            }],
            emojis: vec![],
            categories: vec![SourceCategory {
                discord_id: "c-1".into(),
                name: "Text".into(),
                position: 0,
                permission_overwrites: vec![],
            }],
            channels: vec![SourceChannel {
                discord_id: "ch-1".into(),
                name: "general".into(),
                kind: "text".into(),
                topic: None,
                position: 0,
                category_discord_id: Some("c-1".into()),
                permission_overwrites: vec![SourcePermissionOverwrite {
                    target_discord_id: "r-1".into(),
                    target_type: "role".into(),
                    target_name: Some("Mod".into()),
                    allow: "1024".into(),
                    deny: "0".into(),
                }],
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
        assert_eq!(report.permission_overwrites, 1);
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

        let imported_channel: crate::types::Channel =
            sqlx::query_as("SELECT * FROM channels WHERE server_id = ?")
                .bind(&server_id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(imported_channel.imported);

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
