//! Pure, idempotent maps from `SourceGuild` parts to Ohiyo rows. Each `map_*` returns
//! the existing Ohiyo id on a re-run (resumability), via the provenance table.

use anyhow::Result;
use sqlx::SqlitePool;

use super::model::{SourceAuthor, SourceCategory, SourceChannel, SourceMessage, SourceRole};
use super::{lookup_map, record_map};
use crate::types::{new_id, now_unix};

/// Login-disabled password hash for imported ghost accounts. Not a valid Argon2 PHC
/// string, so `argon2` verification always fails — a ghost can never authenticate.
pub const GHOST_LOCK: &str = "!imported-ghost-no-login";

/// Create (or return the existing) ghost user for a Discord author. Username is
/// import-scoped to stay globally unique even if the same person is imported twice.
pub async fn map_author(db: &SqlitePool, import_id: &str, a: &SourceAuthor) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "user", &a.discord_id).await? {
        return Ok(id);
    }
    let id = new_id();
    let username = format!("discord-{}-{}", &import_id[..8], a.discord_id);
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, avatar_url, created_at)
         VALUES (?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&a.display_name)
    .bind(GHOST_LOCK)
    .bind(&a.avatar_url)
    .bind(now_unix())
    .execute(db)
    .await?;
    record_map(db, import_id, "user", &a.discord_id, &id).await?;
    Ok(id)
}

pub async fn map_category(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    c: &SourceCategory,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "category", &c.discord_id).await? {
        return Ok(id);
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO categories (id, server_id, name, position, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind(server_id)
    .bind(&c.name)
    .bind(c.position)
    .bind(now_unix())
    .execute(db)
    .await?;
    record_map(db, import_id, "category", &c.discord_id, &id).await?;
    Ok(id)
}

pub async fn map_channel(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    ch: &SourceChannel,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "channel", &ch.discord_id).await? {
        return Ok(id);
    }
    let id = new_id();
    let channel_type = if ch.kind == "voice" { "voice" } else { "text" };
    // Category must already be mapped (orchestrator maps categories first). An
    // unresolved/None category just leaves the channel uncategorized.
    let category_id = match &ch.category_discord_id {
        Some(d) => lookup_map(db, import_id, "category", d).await?,
        None => None,
    };
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position, topic, \
         created_at, category_id, imported)
         VALUES (?,?,?,?,?,?,?,?,1)",
    )
    .bind(&id)
    .bind(server_id)
    .bind(&ch.name)
    .bind(channel_type)
    .bind(ch.position)
    .bind(&ch.topic)
    .bind(now_unix())
    .bind(&category_id)
    .execute(db)
    .await?;
    record_map(db, import_id, "channel", &ch.discord_id, &id).await?;
    Ok(id)
}

/// Map a single message. `author_id` is the ghost user's Ohiyo id (already mapped).
/// `attachments_json` is a JSON array string of Ohiyo file ids, or None.
pub async fn map_message(
    db: &SqlitePool,
    import_id: &str,
    channel_id: &str,
    author_id: &str,
    m: &SourceMessage,
    attachments_json: Option<&str>,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "message", &m.discord_id).await? {
        return Ok(id);
    }
    let id = new_id();
    // A reply target may be in another channel or filtered out of the window; an
    // unresolved reply simply becomes a non-quoting message.
    let reply_to = match &m.reply_to_discord_id {
        Some(d) => lookup_map(db, import_id, "message", d).await?,
        None => None,
    };
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to, \
         pinned, attachments)
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(channel_id)
    .bind(author_id)
    .bind(&m.content)
    .bind(m.created_at)
    .bind(&reply_to)
    .bind(i64::from(m.pinned))
    .bind(attachments_json)
    .execute(db)
    .await?;
    record_map(db, import_id, "message", &m.discord_id, &id).await?;
    Ok(id)
}

/// Map one per-user reaction. The `(message_id, user_id, emoji)` primary key makes
/// `INSERT OR IGNORE` idempotent with no separate provenance row needed.
pub async fn map_reaction(
    db: &SqlitePool,
    message_id: &str,
    reactor_id: &str,
    emoji: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) \
         VALUES (?,?,?,?)",
    )
    .bind(message_id)
    .bind(reactor_id)
    .bind(emoji)
    .bind(now_unix())
    .execute(db)
    .await?;
    Ok(())
}

/// Map a Discord role to an Ohiyo role with NO permissions (see task rationale).
pub async fn map_role(
    db: &SqlitePool,
    import_id: &str,
    server_id: &str,
    r: &SourceRole,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "role", &r.discord_id).await? {
        return Ok(id);
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at)
         VALUES (?,?,?,?,0,0,?)",
    )
    .bind(&id)
    .bind(server_id)
    .bind(&r.name)
    .bind(&r.color)
    .bind(now_unix())
    .execute(db)
    .await?;
    record_map(db, import_id, "role", &r.discord_id, &id).await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::create_import;
    use crate::import::tests::test_db;

    fn author(id: &str, name: &str) -> SourceAuthor {
        SourceAuthor {
            discord_id: id.into(),
            display_name: name.into(),
            avatar_url: None,
        }
    }

    fn channel(id: &str, name: &str, kind: &str) -> SourceChannel {
        SourceChannel {
            discord_id: id.into(),
            name: name.into(),
            kind: kind.into(),
            topic: None,
            position: 0,
            category_discord_id: None,
            messages: vec![],
        }
    }

    fn message(id: &str, author: &str, content: &str, at: i64) -> SourceMessage {
        SourceMessage {
            discord_id: id.into(),
            author_discord_id: author.into(),
            content: content.into(),
            created_at: at,
            reply_to_discord_id: None,
            pinned: false,
            attachments: vec![],
            reactions: vec![],
        }
    }

    #[tokio::test]
    async fn creates_locked_ghost_user() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let uid = map_author(&db, &import_id, &author("d-1", "Alice"))
            .await
            .unwrap();
        let (name, hash): (String, String) =
            sqlx::query_as("SELECT display_name, password_hash FROM users WHERE id = ?")
                .bind(&uid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(name, "Alice");
        assert_eq!(hash, GHOST_LOCK);
    }

    #[tokio::test]
    async fn map_author_is_idempotent() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let a = author("d-1", "Alice");
        let first = map_author(&db, &import_id, &a).await.unwrap();
        let second = map_author(&db, &import_id, &a).await.unwrap();
        assert_eq!(first, second);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?")
            .bind(&first)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn maps_category_idempotently() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let c = SourceCategory {
            discord_id: "c-1".into(),
            name: "Text".into(),
            position: 0,
        };
        let a = map_category(&db, &import_id, "s1", &c).await.unwrap();
        let b = map_category(&db, &import_id, "s1", &c).await.unwrap();
        assert_eq!(a, b);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn channel_is_marked_imported_and_typed() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text"))
            .await
            .unwrap();
        let (ctype, imported): (String, i64) =
            sqlx::query_as("SELECT channel_type, imported FROM channels WHERE id = ?")
                .bind(&cid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(ctype, "text");
        assert_eq!(imported, 1);
    }

    #[tokio::test]
    async fn voice_channel_maps_to_voice_type() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let cid = map_channel(&db, &import_id, "s1", &channel("ch-2", "Lounge", "voice"))
            .await
            .unwrap();
        let (ctype, imported): (String, i64) =
            sqlx::query_as("SELECT channel_type, imported FROM channels WHERE id = ?")
                .bind(&cid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(ctype, "voice");
        assert_eq!(imported, 1);
    }

    #[tokio::test]
    async fn map_channel_is_idempotent() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let ch = channel("ch-3", "general", "text");
        let a = map_channel(&db, &import_id, "s1", &ch).await.unwrap();
        let b = map_channel(&db, &import_id, "s1", &ch).await.unwrap();
        assert_eq!(a, b);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM channels")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn maps_message_with_resolved_reply() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text"))
            .await
            .unwrap();
        let uid = map_author(&db, &import_id, &author("d-1", "Alice"))
            .await
            .unwrap();

        let first = message("m-1", "d-1", "hi", 100);
        let oid1 = map_message(&db, &import_id, &cid, &uid, &first, None)
            .await
            .unwrap();

        let mut reply = message("m-2", "d-1", "re: hi", 200);
        reply.reply_to_discord_id = Some("m-1".into());
        map_message(&db, &import_id, &cid, &uid, &reply, None)
            .await
            .unwrap();

        let reply_to: Option<String> =
            sqlx::query_scalar("SELECT reply_to FROM messages WHERE content = 're: hi'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(reply_to.as_deref(), Some(oid1.as_str()));
    }

    #[tokio::test]
    async fn map_message_is_idempotent() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text"))
            .await
            .unwrap();
        let uid = map_author(&db, &import_id, &author("d-1", "Alice"))
            .await
            .unwrap();
        let m = message("m-1", "d-1", "hi", 100);
        map_message(&db, &import_id, &cid, &uid, &m, None)
            .await
            .unwrap();
        map_message(&db, &import_id, &cid, &uid, &m, None)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn map_reaction_is_idempotent() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text"))
            .await
            .unwrap();
        let uid = map_author(&db, &import_id, &author("d-1", "Alice"))
            .await
            .unwrap();
        let mid = map_message(
            &db,
            &import_id,
            &cid,
            &uid,
            &message("m-1", "d-1", "hi", 1),
            None,
        )
        .await
        .unwrap();
        map_reaction(&db, &mid, &uid, "👍").await.unwrap();
        map_reaction(&db, &mid, &uid, "👍").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE message_id = ?")
            .bind(&mid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn role_imports_with_zero_permissions() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let r = SourceRole {
            discord_id: "r-1".into(),
            name: "Mod".into(),
            color: Some("#f50".into()),
        };
        let rid = map_role(&db, &import_id, "s1", &r).await.unwrap();
        let perms: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
            .bind(&rid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(perms, 0);
    }

    #[tokio::test]
    async fn map_role_is_idempotent() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let r = SourceRole {
            discord_id: "r-1".into(),
            name: "Mod".into(),
            color: Some("#f50".into()),
        };
        let a = map_role(&db, &import_id, "s1", &r).await.unwrap();
        let b = map_role(&db, &import_id, "s1", &r).await.unwrap();
        assert_eq!(a, b);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
