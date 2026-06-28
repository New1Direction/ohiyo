//! Read a real Discrawl SQLite archive into the stable Phase 1 [`SourceGuild`] model.
//!
//! Discrawl keeps Discord channels and threads in one `channels` table, canonical
//! messages in `messages`, member snapshots in `members`, and downloaded media
//! metadata in `message_attachments`. This reader is intentionally read-only and
//! schema-narrow: it consumes only documented columns so Discrawl can add new tables
//! without breaking Ohiyo imports.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::{Path, PathBuf};

use super::model::{
    SourceAttachment, SourceAuthor, SourceCategory, SourceChannel, SourceGuild, SourceMessage,
    SourceReaction, SourceRole,
};

#[derive(Debug, Clone, Default)]
pub struct DiscrawlReadOptions {
    /// Discord guild snowflake. When omitted, the first non-`@me` guild is selected.
    pub guild_id: Option<String>,
    /// Base directory for Discrawl-downloaded media. `message_attachments.media_path`
    /// is relative to this directory. If omitted, attachments without absolute media
    /// paths are skipped (metadata remains represented by message text only).
    pub media_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DiscrawlPreview {
    pub guild_id: String,
    pub guild_name: String,
    pub categories: u32,
    pub channels: u32,
    pub voice_channels: u32,
    pub threads: u32,
    pub authors: u32,
    pub messages: u32,
    pub attachments: u32,
    pub downloaded_attachments: u32,
}

pub async fn read_source_guild(
    db_path: impl AsRef<Path>,
    opts: DiscrawlReadOptions,
) -> Result<SourceGuild> {
    let db = open_discrawl_db(db_path).await?;
    read_source_guild_from_pool(&db, opts).await
}

pub async fn preview(
    db_path: impl AsRef<Path>,
    opts: DiscrawlReadOptions,
) -> Result<DiscrawlPreview> {
    let db = open_discrawl_db(db_path).await?;
    preview_from_pool(&db, opts).await
}

async fn open_discrawl_db(db_path: impl AsRef<Path>) -> Result<SqlitePool> {
    let path = db_path.as_ref();
    let url = format!("sqlite:{}", path.display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .with_context(|| format!("open Discrawl SQLite archive at {}", path.display()))
}

async fn selected_guild(
    db: &SqlitePool,
    requested: Option<&str>,
) -> Result<(String, String, Option<String>)> {
    let row = if let Some(id) = requested {
        sqlx::query("SELECT id, name, icon FROM guilds WHERE id = ?")
            .bind(id)
            .fetch_optional(db)
            .await?
            .with_context(|| format!("Discrawl guild not found: {id}"))?
    } else {
        sqlx::query("SELECT id, name, icon FROM guilds WHERE id <> '@me' ORDER BY id LIMIT 1")
            .fetch_optional(db)
            .await?
            .context("Discrawl archive contains no importable guilds")?
    };

    Ok((row.get("id"), row.get("name"), row.try_get("icon").ok()))
}

pub async fn preview_from_pool(
    db: &SqlitePool,
    opts: DiscrawlReadOptions,
) -> Result<DiscrawlPreview> {
    let (guild_id, guild_name, _) = selected_guild(db, opts.guild_id.as_deref()).await?;
    let categories = count_i64(
        db,
        "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND kind = 'category'",
        &guild_id,
    )
    .await?;
    let voice_channels = count_i64(
        db,
        "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND kind = 'voice'",
        &guild_id,
    )
    .await?;
    let threads = count_i64(
        db,
        "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND kind LIKE 'thread_%'",
        &guild_id,
    )
    .await?;
    let channels = count_i64(db, "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND kind IN ('text','announcement','forum','voice','thread_public','thread_private','thread_announcement')", &guild_id).await?;
    let authors = count_i64(db, "SELECT COUNT(DISTINCT author_id) FROM messages WHERE guild_id = ? AND author_id IS NOT NULL AND author_id <> ''", &guild_id).await?;
    let messages = count_i64(
        db,
        "SELECT COUNT(*) FROM messages WHERE guild_id = ? AND deleted_at IS NULL",
        &guild_id,
    )
    .await?;
    let attachments = count_i64(
        db,
        "SELECT COUNT(*) FROM message_attachments WHERE guild_id = ?",
        &guild_id,
    )
    .await?;
    let downloaded_attachments = count_i64(db, "SELECT COUNT(*) FROM message_attachments WHERE guild_id = ? AND COALESCE(media_path, '') <> ''", &guild_id).await?;

    Ok(DiscrawlPreview {
        guild_id,
        guild_name,
        categories: categories as u32,
        channels: channels as u32,
        voice_channels: voice_channels as u32,
        threads: threads as u32,
        authors: authors as u32,
        messages: messages as u32,
        attachments: attachments as u32,
        downloaded_attachments: downloaded_attachments as u32,
    })
}

async fn count_i64(db: &SqlitePool, sql: &str, guild_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(sql).bind(guild_id).fetch_one(db).await?)
}

pub async fn read_source_guild_from_pool(
    db: &SqlitePool,
    opts: DiscrawlReadOptions,
) -> Result<SourceGuild> {
    let (guild_id, guild_name, icon_url) = selected_guild(db, opts.guild_id.as_deref()).await?;

    let authors = read_authors(db, &guild_id).await?;
    let roles = read_roles_from_mentions(db, &guild_id).await?;
    let categories = read_categories(db, &guild_id).await?;
    let channels = read_channels(db, &guild_id, opts.media_root.as_deref()).await?;

    Ok(SourceGuild {
        discord_id: guild_id,
        name: guild_name,
        icon_url,
        authors,
        roles,
        emojis: vec![],
        categories,
        channels,
    })
}

async fn read_authors(db: &SqlitePool, guild_id: &str) -> Result<Vec<SourceAuthor>> {
    let rows = sqlx::query(
        "SELECT DISTINCT m.author_id,
                COALESCE(NULLIF(mem.display_name, ''), NULLIF(mem.nick, ''), NULLIF(mem.global_name, ''), NULLIF(mem.username, ''), '') AS display_name,
                mem.avatar,
                m.raw_json
         FROM messages m
         LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = m.author_id
         WHERE m.guild_id = ? AND m.author_id IS NOT NULL AND m.author_id <> ''
         ORDER BY display_name, m.author_id",
    )
    .bind(guild_id)
    .fetch_all(db)
    .await?;

    rows.into_iter()
        .map(|row| {
            let discord_id: String = row.get("author_id");
            let display_name: String = row.get("display_name");
            let raw_json: String = row.get("raw_json");
            Ok(SourceAuthor {
                discord_id,
                display_name: if display_name.trim().is_empty() {
                    author_name_from_message_raw(&raw_json)
                        .unwrap_or_else(|| "Discord user".to_string())
                } else {
                    display_name
                },
                avatar_url: row
                    .try_get("avatar")
                    .ok()
                    .filter(|s: &String| !s.trim().is_empty()),
            })
        })
        .collect()
}

async fn read_roles_from_mentions(db: &SqlitePool, guild_id: &str) -> Result<Vec<SourceRole>> {
    let rows = sqlx::query(
        "SELECT target_id, COALESCE(NULLIF(target_name, ''), target_id) AS name
         FROM mention_events
         WHERE guild_id = ? AND target_type = 'role' AND target_id <> ''
         GROUP BY target_id
         ORDER BY name, target_id",
    )
    .bind(guild_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SourceRole {
            discord_id: row.get("target_id"),
            name: row.get("name"),
            color: None,
            permissions: None,
            position: 0,
        })
        .collect())
}

async fn read_categories(db: &SqlitePool, guild_id: &str) -> Result<Vec<SourceCategory>> {
    let rows = sqlx::query(
        "SELECT id, name, COALESCE(position, 0) AS position
         FROM channels
         WHERE guild_id = ? AND kind = 'category'
         ORDER BY position, name, id",
    )
    .bind(guild_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SourceCategory {
            discord_id: row.get("id"),
            name: row.get("name"),
            position: row.get("position"),
        })
        .collect())
}

async fn read_channels(
    db: &SqlitePool,
    guild_id: &str,
    media_root: Option<&Path>,
) -> Result<Vec<SourceChannel>> {
    let rows = sqlx::query(
        "SELECT id, kind, name, topic, COALESCE(position, 0) AS position,
                parent_id, thread_parent_id
         FROM channels
         WHERE guild_id = ?
           AND kind IN ('text','announcement','forum','voice','thread_public','thread_private','thread_announcement')
         ORDER BY position, name, id",
    )
    .bind(guild_id)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let kind: String = row.get("kind");
        let messages = if kind == "voice" {
            Vec::new()
        } else {
            read_messages(db, guild_id, &id, media_root).await?
        };
        out.push(SourceChannel {
            discord_id: id,
            name: row.get("name"),
            kind: if kind == "voice" {
                "voice".into()
            } else {
                "text".into()
            },
            topic: row.try_get("topic").ok(),
            position: row.get("position"),
            category_discord_id: category_for_channel(&row, &kind),
            permission_overwrites: vec![],
            messages,
        });
    }
    Ok(out)
}

fn category_for_channel(row: &sqlx::sqlite::SqliteRow, kind: &str) -> Option<String> {
    let parent_id: Option<String> = row.try_get("parent_id").ok();
    let thread_parent_id: Option<String> = row.try_get("thread_parent_id").ok();
    if kind.starts_with("thread_") {
        // Discrawl stores a thread's channel parent here. Phase 1 models threads as
        // channels; the parent channel may not be a category, so leave this uncategorized
        // rather than inventing an invalid category mapping.
        thread_parent_id.filter(|s| !s.trim().is_empty() && s != parent_id.as_deref().unwrap_or(""))
    } else {
        parent_id.filter(|s| !s.trim().is_empty())
    }
}

async fn read_messages(
    db: &SqlitePool,
    guild_id: &str,
    channel_id: &str,
    media_root: Option<&Path>,
) -> Result<Vec<SourceMessage>> {
    let rows = sqlx::query(
        "SELECT id, COALESCE(author_id, '') AS author_id, content, created_at,
                reply_to_message_id, pinned, raw_json
         FROM messages
         WHERE guild_id = ? AND channel_id = ? AND deleted_at IS NULL
         ORDER BY created_at, id",
    )
    .bind(guild_id)
    .bind(channel_id)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let message_id: String = row.get("id");
        let raw_json: String = row.get("raw_json");
        out.push(SourceMessage {
            discord_id: message_id.clone(),
            author_discord_id: row.get("author_id"),
            content: row.get("content"),
            created_at: parse_discrawl_time(row.get::<String, _>("created_at").as_str())?,
            reply_to_discord_id: row
                .try_get("reply_to_message_id")
                .ok()
                .filter(|s: &String| !s.trim().is_empty()),
            pinned: row.get::<i64, _>("pinned") != 0,
            attachments: read_attachments(db, guild_id, channel_id, &message_id, media_root)
                .await?,
            reactions: reactions_from_raw(&raw_json),
        });
    }
    Ok(out)
}

async fn read_attachments(
    db: &SqlitePool,
    guild_id: &str,
    channel_id: &str,
    message_id: &str,
    media_root: Option<&Path>,
) -> Result<Vec<SourceAttachment>> {
    let rows = sqlx::query(
        "SELECT attachment_id, filename, content_type, media_path
         FROM message_attachments
         WHERE guild_id = ? AND channel_id = ? AND message_id = ?
         ORDER BY attachment_id",
    )
    .bind(guild_id)
    .bind(channel_id)
    .bind(message_id)
    .fetch_all(db)
    .await?;

    let mut out = Vec::new();
    for row in rows {
        let Some(local_path) = attachment_local_path(row.try_get("media_path").ok(), media_root)
        else {
            continue;
        };
        out.push(SourceAttachment {
            discord_id: row.get("attachment_id"),
            filename: row.get("filename"),
            content_type: row
                .try_get("content_type")
                .ok()
                .filter(|s: &String| !s.trim().is_empty())
                .unwrap_or_else(|| "application/octet-stream".into()),
            local_path,
        });
    }
    Ok(out)
}

fn attachment_local_path(media_path: Option<String>, media_root: Option<&Path>) -> Option<String> {
    let media_path = media_path?.trim().to_string();
    if media_path.is_empty() {
        return None;
    }
    // A media file is only safe to read if it resolves INSIDE the configured media_root.
    // A crafted archive must not be able to point at an absolute path (`/etc/passwd`) or
    // escape via `..`; without a root there's no safe base at all. The check is LEXICAL —
    // canonicalize() can't be used because the file may not exist yet at scan time.
    let root = media_root?;
    let path = PathBuf::from(&media_path);
    let resolved = if path.is_absolute() {
        path
    } else {
        root.join(&path)
    };
    if resolved
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    if !resolved.starts_with(root) {
        return None;
    }
    Some(resolved.to_string_lossy().into_owned())
}

fn parse_discrawl_time(s: &str) -> Result<i64> {
    Ok(DateTime::parse_from_rfc3339(s)
        .with_context(|| format!("parse Discrawl timestamp {s:?}"))?
        .with_timezone(&Utc)
        .timestamp())
}

#[derive(Deserialize)]
struct RawMessageAuthor {
    username: Option<String>,
    global_name: Option<String>,
}

#[derive(Deserialize)]
struct RawMessage {
    author: Option<RawMessageAuthor>,
}

fn author_name_from_message_raw(raw: &str) -> Option<String> {
    let parsed: RawMessage = serde_json::from_str(raw).ok()?;
    let author = parsed.author?;
    author
        .global_name
        .filter(|s| !s.trim().is_empty())
        .or_else(|| author.username.filter(|s| !s.trim().is_empty()))
}

fn reactions_from_raw(_raw: &str) -> Vec<SourceReaction> {
    // Discord's message `reactions` array carries counts, not the users who reacted.
    // Ohiyo's Phase 1 model intentionally needs per-user reactions, so a Discrawl
    // reader must not fabricate reactors. Return none until Discrawl exposes per-user
    // reaction events.
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const DISCRAWL_SCHEMA: &str = r#"
        CREATE TABLE guilds (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE channels (
            id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            parent_id TEXT,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            topic TEXT,
            position INTEGER,
            is_nsfw INTEGER NOT NULL DEFAULT 0,
            is_archived INTEGER NOT NULL DEFAULT 0,
            is_locked INTEGER NOT NULL DEFAULT 0,
            is_private_thread INTEGER NOT NULL DEFAULT 0,
            thread_parent_id TEXT,
            archive_timestamp TEXT,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE members (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            global_name TEXT,
            display_name TEXT,
            nick TEXT,
            discriminator TEXT,
            avatar TEXT,
            bot INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT,
            role_ids_json TEXT NOT NULL,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            author_id TEXT,
            message_type INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            edited_at TEXT,
            deleted_at TEXT,
            content TEXT NOT NULL,
            normalized_content TEXT NOT NULL,
            reply_to_message_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            has_attachments INTEGER NOT NULL DEFAULT 0,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE message_attachments (
            attachment_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            author_id TEXT,
            filename TEXT NOT NULL,
            content_type TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            url TEXT,
            proxy_url TEXT,
            text_content TEXT NOT NULL DEFAULT '',
            media_path TEXT,
            content_sha256 TEXT,
            content_size INTEGER NOT NULL DEFAULT 0,
            fetched_at TEXT,
            fetch_status TEXT NOT NULL DEFAULT '',
            fetch_error TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE mention_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            author_id TEXT,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            target_name TEXT NOT NULL DEFAULT '',
            event_at TEXT NOT NULL
        );
    "#;

    async fn discrawl_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for stmt in DISCRAWL_SCHEMA.split(';') {
            let stmt = stmt.trim();
            if !stmt.is_empty() {
                sqlx::query(stmt).execute(&db).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO guilds (id, name, icon, raw_json, updated_at) VALUES ('g1','Guild','https://cdn/icon.png','{}','2026-01-01T00:00:00Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO channels (id, guild_id, parent_id, kind, name, topic, position, raw_json, updated_at) VALUES ('cat1','g1',NULL,'category','Text',NULL,0,'{}','2026-01-01T00:00:00Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO channels (id, guild_id, parent_id, kind, name, topic, position, raw_json, updated_at) VALUES ('ch1','g1','cat1','text','general','hi',1,'{}','2026-01-01T00:00:00Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO channels (id, guild_id, parent_id, kind, name, topic, position, raw_json, updated_at) VALUES ('v1','g1','cat1','voice','Lounge',NULL,2,'{}','2026-01-01T00:00:00Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO members (guild_id, user_id, username, global_name, display_name, nick, discriminator, avatar, bot, joined_at, role_ids_json, raw_json, updated_at) VALUES ('g1','u1','alice','Alice G','Alice',NULL,'0','https://cdn/avatar.png',0,NULL,'[]','{}','2026-01-01T00:00:00Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO messages (id, guild_id, channel_id, author_id, message_type, created_at, edited_at, deleted_at, content, normalized_content, reply_to_message_id, pinned, has_attachments, raw_json, updated_at) VALUES ('m1','g1','ch1','u1',0,'2026-01-02T03:04:05Z',NULL,NULL,'hello','hello',NULL,1,1,'{}','2026-01-02T03:04:05Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO mention_events (message_id, guild_id, channel_id, author_id, target_type, target_id, target_name, event_at) VALUES ('m1','g1','ch1','u1','role','r1','Mod','2026-01-02T03:04:05Z')")
            .execute(&db).await.unwrap();
        sqlx::query("INSERT INTO message_attachments (attachment_id, message_id, guild_id, channel_id, author_id, filename, content_type, size, media_path, updated_at) VALUES ('a1','m1','g1','ch1','u1','note.txt','text/plain',5,'aa/note.txt','2026-01-02T03:04:05Z')")
            .execute(&db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn preview_counts_discrawl_archive() {
        let db = discrawl_db().await;
        let got = preview_from_pool(&db, DiscrawlReadOptions::default())
            .await
            .unwrap();
        assert_eq!(got.guild_name, "Guild");
        assert_eq!(got.categories, 1);
        assert_eq!(got.channels, 2);
        assert_eq!(got.voice_channels, 1);
        assert_eq!(got.messages, 1);
        assert_eq!(got.attachments, 1);
        assert_eq!(got.downloaded_attachments, 1);
    }

    #[tokio::test]
    async fn reads_source_guild_from_discrawl_archive() {
        let db = discrawl_db().await;
        let guild = read_source_guild_from_pool(
            &db,
            DiscrawlReadOptions {
                guild_id: Some("g1".into()),
                media_root: Some(PathBuf::from("/media")),
            },
        )
        .await
        .unwrap();

        assert_eq!(guild.discord_id, "g1");
        assert_eq!(guild.authors[0].display_name, "Alice");
        assert_eq!(guild.roles[0].name, "Mod");
        assert_eq!(guild.categories[0].name, "Text");
        assert_eq!(guild.channels.len(), 2);
        assert_eq!(
            guild.channels[0].category_discord_id.as_deref(),
            Some("cat1")
        );
        assert_eq!(guild.channels[0].messages[0].created_at, 1_767_323_045);
        assert_eq!(
            guild.channels[0].messages[0].attachments[0].local_path,
            "/media/aa/note.txt"
        );
        assert_eq!(guild.channels[1].kind, "voice");
    }

    #[test]
    fn attachment_local_path_confines_to_media_root() {
        let root = PathBuf::from("/media");
        // Relative paths resolve under the root (the normal case).
        assert_eq!(
            attachment_local_path(Some("aa/note.txt".into()), Some(&root)).as_deref(),
            Some("/media/aa/note.txt")
        );
        // An absolute path outside the root is rejected (no `/etc/passwd` exfiltration).
        assert_eq!(
            attachment_local_path(Some("/etc/passwd".into()), Some(&root)),
            None
        );
        // `..` traversal is rejected.
        assert_eq!(
            attachment_local_path(Some("../../etc/passwd".into()), Some(&root)),
            None
        );
        // No media_root → nothing to confine against → rejected.
        assert_eq!(attachment_local_path(Some("/media/x".into()), None), None);
    }
}
