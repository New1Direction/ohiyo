# Discord Import — Phase 1 (Importer Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map a stable in-memory `SourceGuild` model into a brand-new Ohiyo space — categories, channels, threads-as-channels, history, attachments, reactions, roles, ghost authors — idempotently and resumably, returning a transparency report.

**Architecture:** A new `server/src/import/` module following the existing `provision/` service pattern: pure `async` functions over `&SqlitePool` returning `anyhow::Result`, unit-tested inline with a single-connection in-memory `test_db()`. A provenance table (`discord_import_map`) keyed by Discord snowflake gives every mapper idempotency and the whole job resumability. The importer's stable input is the `SourceGuild` model — decoupling all mapping logic from discrawl's actual schema, which Phase 2 will read into this model.

**Tech Stack:** Rust 2021, axum 0.8, sqlx 0.8 (SQLite), anyhow, sha2, imagesize, tokio fs.

## Global Constraints

- sqlx SQLite bind placeholders are `?`; never format user/source data into SQL strings.
- No `.unwrap()` / `.expect()` outside `#[cfg(test)]`; propagate with `?` and `anyhow`.
- `cargo fmt` clean; `cargo clippy -- -D warnings` clean; max line width 100.
- Service pattern: pure `async fn` over `&SqlitePool`; no axum extractors in `import/` (it is not an HTTP layer in Phase 1).
- Idempotency is keyed by **Discord snowflake** via `discord_import_map`; every mapper must early-return the existing Ohiyo id on a second run for the same `(import_id, entity_type, discord_id)`.
- Imported channels are marked `imported = 1` (backs the client's "not end-to-end encrypted" badge — client rendering is out of Phase 1 scope).
- Ghost users are login-disabled: `password_hash` is the sentinel `"!imported-ghost-no-login"` (never a valid Argon2 PHC string, so login always fails).
- Migrations are append-only, numbered after the latest (`0027_hosted_instances.sql` → new file is `0028_*`).

---

### Task 1: Migration + provenance backbone

**Files:**
- Create: `server/migrations/0028_discord_import.sql`
- Create: `server/src/import/mod.rs`
- Modify: `server/src/lib.rs:10-18` (add `pub mod import;` to the module list)

**Interfaces:**
- Produces: `import::create_import(db, owner_id, guild_id, server_id) -> anyhow::Result<String>` (returns `import_id`); `import::set_status(db, import_id, status) -> anyhow::Result<()>`; `import::record_map(db, import_id, entity_type, discord_id, ohiyo_id) -> anyhow::Result<()>`; `import::lookup_map(db, import_id, entity_type, discord_id) -> anyhow::Result<Option<String>>`.

- [ ] **Step 1: Write the migration**

Create `server/migrations/0028_discord_import.sql`:

```sql
-- One-time Discord import jobs and their snowflake→Ohiyo provenance map.
-- The map is what makes every mapper idempotent and the whole job resumable.
CREATE TABLE discord_imports (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,                 -- Discord guild snowflake
    owner_id   TEXT NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL,                 -- 'running' | 'partial' | 'complete' | 'failed'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE discord_import_map (
    import_id   TEXT NOT NULL REFERENCES discord_imports(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,                -- 'user'|'role'|'category'|'channel'|'message'|'attachment'
    discord_id  TEXT NOT NULL,                -- source snowflake
    ohiyo_id    TEXT NOT NULL,
    PRIMARY KEY (import_id, entity_type, discord_id)
);

-- Mark channels that originated from an import so the client can badge them
-- "Imported from Discord — not end-to-end encrypted".
ALTER TABLE channels ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Register the module and write the failing test**

In `server/src/lib.rs`, add `pub mod import;` alongside the other `pub mod` lines (after `pub mod gateway;`).

Create `server/src/import/mod.rs`:

```rust
//! One-click Discord server import (Phase 1: offline core).
//!
//! Maps a stable [`model::SourceGuild`] into a fresh Ohiyo space. All mapping is
//! idempotent and resumable via the `discord_import_map` provenance table, keyed by
//! the source Discord snowflake.

use anyhow::Result;
use sqlx::SqlitePool;

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
    sqlx::query("UPDATE discord_imports SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_unix())
        .bind(import_id)
        .execute(db)
        .await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Single-connection in-memory DB seeded with an owner user + a server, so the
    /// FK-constrained import rows have valid parents. (Multi-conn `:memory:` hands out
    /// separate empty DBs — see provision/mod.rs test_db for the same constraint.)
    pub(super) async fn test_db() -> SqlitePool {
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
        record_map(&db, &import_id, "user", "disc-1", "first").await.unwrap();
        record_map(&db, &import_id, "user", "disc-1", "second").await.unwrap();
        assert_eq!(
            lookup_map(&db, &import_id, "user", "disc-1").await.unwrap().as_deref(),
            Some("first")
        );
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd server && cargo test --lib import::tests`
Expected: PASS (2 tests). If `migrate!` fails, the migration is malformed — fix it before proceeding.

- [ ] **Step 4: Verify lint + format**

Run: `cd server && cargo fmt && cargo clippy --lib -- -D warnings`
Expected: no warnings.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/0028_discord_import.sql server/src/import/mod.rs server/src/lib.rs
git commit -m "feat(import): provenance table + job lifecycle for Discord import"
```

---

### Task 2: Source model + history window

**Files:**
- Create: `server/src/import/model.rs`
- Modify: `server/src/import/mod.rs` (add `pub mod model;` at the top, under the doc comment)

**Interfaces:**
- Produces: structs `SourceAuthor`, `SourceRole`, `SourceCategory`, `SourceChannel`, `SourceMessage`, `SourceReaction`, `SourceAttachment`, `SourceGuild`; enum `HistoryWindow { All, Last90Days }`; struct `ImportOptions { history: HistoryWindow }`; free fn `model::within_window(created_at: i64, window: HistoryWindow, now: i64) -> bool`.

- [ ] **Step 1: Write the failing test**

Create `server/src/import/model.rs`:

```rust
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
        assert!(!within_window(now - NINETY_DAYS_SECS - 1, HistoryWindow::Last90Days, now));
    }
}
```

In `server/src/import/mod.rs`, add under the doc comment (before `use anyhow::Result;`):

```rust
pub mod model;
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::model`
Expected: PASS (2 tests).

- [ ] **Step 3: Verify lint + format**

Run: `cd server && cargo fmt && cargo clippy --lib -- -D warnings`
Expected: no warnings.

- [ ] **Step 4: Commit**

```bash
git add server/src/import/model.rs server/src/import/mod.rs
git commit -m "feat(import): SourceGuild model + history-window filter"
```

---

### Task 3: Ghost author mapping

**Files:**
- Create: `server/src/import/mapper.rs`
- Modify: `server/src/import/mod.rs` (add `pub mod mapper;`)

**Interfaces:**
- Consumes: `lookup_map`, `record_map` (Task 1); `model::SourceAuthor` (Task 2).
- Produces: `mapper::map_author(db, import_id, a: &SourceAuthor) -> anyhow::Result<String>` (returns the ghost user's Ohiyo id); `mapper::GHOST_LOCK: &str`.

- [ ] **Step 1: Write the failing test**

Create `server/src/import/mapper.rs`:

```rust
//! Pure, idempotent maps from `SourceGuild` parts to Ohiyo rows. Each `map_*` returns
//! the existing Ohiyo id on a re-run (resumability), via the provenance table.

use anyhow::Result;
use sqlx::SqlitePool;

use super::model::SourceAuthor;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::tests::test_db;
    use crate::import::create_import;

    fn author(id: &str, name: &str) -> SourceAuthor {
        SourceAuthor { discord_id: id.into(), display_name: name.into(), avatar_url: None }
    }

    #[tokio::test]
    async fn creates_locked_ghost_user() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let uid = map_author(&db, &import_id, &author("d-1", "Alice")).await.unwrap();
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
}
```

In `server/src/import/mod.rs` add `pub mod mapper;` (next to `pub mod model;`). Also make the test `test_db` reachable from sibling modules: change `pub(super) async fn test_db()` in Task 1's test module to `pub(crate) async fn test_db()`.

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::mapper`
Expected: PASS (2 tests).

- [ ] **Step 3: Verify lint + format**

Run: `cd server && cargo fmt && cargo clippy --lib -- -D warnings`
Expected: no warnings.

- [ ] **Step 4: Commit**

```bash
git add server/src/import/mapper.rs server/src/import/mod.rs
git commit -m "feat(import): map Discord authors to login-disabled ghost users"
```

---

### Task 4: Category mapping

**Files:**
- Modify: `server/src/import/mapper.rs`

**Interfaces:**
- Consumes: `model::SourceCategory`, provenance helpers.
- Produces: `mapper::map_category(db, import_id, server_id, c: &SourceCategory) -> anyhow::Result<String>`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/import/mapper.rs` (add `use super::model::SourceCategory;` to the imports):

```rust
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
```

Append to the `tests` module:

```rust
#[tokio::test]
async fn maps_category_idempotently() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let c = SourceCategory { discord_id: "c-1".into(), name: "Text".into(), position: 0 };
    let a = map_category(&db, &import_id, "s1", &c).await.unwrap();
    let b = map_category(&db, &import_id, "s1", &c).await.unwrap();
    assert_eq!(a, b);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories")
        .fetch_one(&db).await.unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::mapper::tests::maps_category`
Expected: PASS.

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/mapper.rs
git commit -m "feat(import): map Discord categories"
```

---

### Task 5: Channel mapping (type normalization + imported flag + category link)

**Files:**
- Modify: `server/src/import/mapper.rs`

**Interfaces:**
- Consumes: `model::SourceChannel`, `map_category` provenance (category links resolved via `lookup_map`).
- Produces: `mapper::map_channel(db, import_id, server_id, ch: &SourceChannel) -> anyhow::Result<String>`.

- [ ] **Step 1: Write the failing test**

Append to `mapper.rs` (add `use super::model::SourceChannel;`):

```rust
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
        "INSERT INTO channels (id, server_id, name, channel_type, position, topic, created_at, category_id, imported)
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
```

Append to `tests` (helper to build a channel with no messages):

```rust
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

#[tokio::test]
async fn channel_is_marked_imported_and_typed() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text"))
        .await.unwrap();
    let (ctype, imported): (String, i64) =
        sqlx::query_as("SELECT channel_type, imported FROM channels WHERE id = ?")
            .bind(&cid).fetch_one(&db).await.unwrap();
    assert_eq!(ctype, "text");
    assert_eq!(imported, 1);
}

#[tokio::test]
async fn voice_channel_maps_to_voice_type() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let cid = map_channel(&db, &import_id, "s1", &channel("ch-2", "Lounge", "voice"))
        .await.unwrap();
    let ctype: String = sqlx::query_scalar("SELECT channel_type FROM channels WHERE id = ?")
        .bind(&cid).fetch_one(&db).await.unwrap();
    assert_eq!(ctype, "voice");
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --lib import::mapper::tests::channel import::mapper::tests::voice`
Expected: PASS (2 tests).

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/mapper.rs
git commit -m "feat(import): map Discord channels (type + imported flag + category)"
```

---

### Task 6: Message mapping (reply + pinned + attachments JSON)

**Files:**
- Modify: `server/src/import/mapper.rs`

**Interfaces:**
- Consumes: `model::SourceMessage`; a pre-resolved `author_ohiyo_id` and `attachments_json` (built by the orchestrator after re-hosting in Task 8).
- Produces: `mapper::map_message(db, import_id, channel_id, author_id, m: &SourceMessage, attachments_json: Option<&str>) -> anyhow::Result<String>`.

- [ ] **Step 1: Write the failing test**

Append to `mapper.rs` (add `use super::model::SourceMessage;`):

```rust
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
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to, pinned, attachments)
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
```

Append to `tests`:

```rust
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
async fn maps_message_with_resolved_reply() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text")).await.unwrap();
    let uid = map_author(&db, &import_id, &author("d-1", "Alice")).await.unwrap();

    let first = message("m-1", "d-1", "hi", 100);
    let oid1 = map_message(&db, &import_id, &cid, &uid, &first, None).await.unwrap();

    let mut reply = message("m-2", "d-1", "re: hi", 200);
    reply.reply_to_discord_id = Some("m-1".into());
    map_message(&db, &import_id, &cid, &uid, &reply, None).await.unwrap();

    let reply_to: Option<String> =
        sqlx::query_scalar("SELECT reply_to FROM messages WHERE content = 're: hi'")
            .fetch_one(&db).await.unwrap();
    assert_eq!(reply_to.as_deref(), Some(oid1.as_str()));
}

#[tokio::test]
async fn map_message_is_idempotent() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text")).await.unwrap();
    let uid = map_author(&db, &import_id, &author("d-1", "Alice")).await.unwrap();
    let m = message("m-1", "d-1", "hi", 100);
    map_message(&db, &import_id, &cid, &uid, &m, None).await.unwrap();
    map_message(&db, &import_id, &cid, &uid, &m, None).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages").fetch_one(&db).await.unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --lib import::mapper::tests::maps_message import::mapper::tests::map_message_is_idempotent`
Expected: PASS (2 tests).

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/mapper.rs
git commit -m "feat(import): map Discord messages (reply + pinned + attachments)"
```

---

### Task 7: Reaction mapping

**Files:**
- Modify: `server/src/import/mapper.rs`

**Interfaces:**
- Consumes: `model::SourceReaction`; the mapped message id and a resolved reactor ghost id.
- Produces: `mapper::map_reaction(db, message_id, reactor_id, emoji) -> anyhow::Result<()>`.

- [ ] **Step 1: Write the failing test**

Append to `mapper.rs`:

```rust
/// Map one per-user reaction. The `(message_id, user_id, emoji)` primary key makes
/// `INSERT OR IGNORE` idempotent with no separate provenance row needed.
pub async fn map_reaction(
    db: &SqlitePool,
    message_id: &str,
    reactor_id: &str,
    emoji: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)",
    )
    .bind(message_id)
    .bind(reactor_id)
    .bind(emoji)
    .bind(now_unix())
    .execute(db)
    .await?;
    Ok(())
}
```

Append to `tests`:

```rust
#[tokio::test]
async fn map_reaction_is_idempotent() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let cid = map_channel(&db, &import_id, "s1", &channel("ch-1", "general", "text")).await.unwrap();
    let uid = map_author(&db, &import_id, &author("d-1", "Alice")).await.unwrap();
    let mid = map_message(&db, &import_id, &cid, &uid, &message("m-1", "d-1", "hi", 1), None)
        .await.unwrap();
    map_reaction(&db, &mid, &uid, "👍").await.unwrap();
    map_reaction(&db, &mid, &uid, "👍").await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE message_id = ?")
        .bind(&mid).fetch_one(&db).await.unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::mapper::tests::map_reaction`
Expected: PASS.

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/mapper.rs
git commit -m "feat(import): map per-user reactions onto ghost authors"
```

---

### Task 8: Attachment re-hosting into Ohiyo file storage

**Files:**
- Create: `server/src/import/attachments.rs`
- Modify: `server/src/import/mod.rs` (add `pub mod attachments;`)

**Interfaces:**
- Consumes: `model::SourceAttachment`; provenance helpers.
- Produces: `attachments::rehost(db, import_id, uploader_id, att: &SourceAttachment) -> anyhow::Result<String>` (returns the Ohiyo file id). Content-addressed, dedup by sha256, mirroring `api/files.rs`.

- [ ] **Step 1: Write the failing test**

Create `server/src/import/attachments.rs`:

```rust
//! Re-host a discrawl-downloaded attachment into Ohiyo's content-addressed file store,
//! reusing the exact `uploads/<sha[0:2]>/<sha[2:4]>/<sha>` layout and `files` schema
//! from `api/files.rs`.

use anyhow::Result;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::path::PathBuf;

use super::model::SourceAttachment;
use super::{lookup_map, record_map};
use crate::types::{new_id, now_unix};

const UPLOAD_DIR: &str = "uploads";

pub async fn rehost(
    db: &SqlitePool,
    import_id: &str,
    uploader_id: &str,
    att: &SourceAttachment,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "attachment", &att.discord_id).await? {
        return Ok(id);
    }

    let bytes = tokio::fs::read(&att.local_path).await?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let size_bytes = bytes.len() as i64;

    // Content dedup: if these exact bytes already exist, reuse the row (and still record
    // the provenance mapping so a resumed run short-circuits next time).
    if let Some(existing) =
        sqlx::query_scalar::<_, String>("SELECT id FROM files WHERE sha256 = ?")
            .bind(&sha256)
            .fetch_optional(db)
            .await?
    {
        record_map(db, import_id, "attachment", &att.discord_id, &existing).await?;
        return Ok(existing);
    }

    let final_path = PathBuf::from(UPLOAD_DIR)
        .join(&sha256[..2])
        .join(&sha256[2..4])
        .join(&sha256);
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&final_path, &bytes).await?;

    let (w, h) = match imagesize::size(&final_path) {
        Ok(dim) => (Some(dim.width as i64), Some(dim.height as i64)),
        Err(_) => (None, None),
    };

    let id = new_id();
    sqlx::query(
        "INSERT INTO files (id, uploader_id, filename, content_type, size_bytes, sha256, path, created_at, width, height)
         VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(uploader_id)
    .bind(&att.filename)
    .bind(&att.content_type)
    .bind(size_bytes)
    .bind(&sha256)
    .bind(final_path.to_string_lossy().as_ref())
    .bind(now_unix())
    .bind(w)
    .bind(h)
    .execute(db)
    .await?;
    record_map(db, import_id, "attachment", &att.discord_id, &id).await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::create_import;
    use crate::import::tests::test_db;

    async fn temp_file(bytes: &[u8]) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!("import-att-{}", new_id()));
        tokio::fs::write(&path, bytes).await.unwrap();
        path.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn rehost_creates_file_row_and_dedups() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let path = temp_file(b"hello-bytes").await;
        let att = SourceAttachment {
            discord_id: "a-1".into(),
            filename: "note.txt".into(),
            content_type: "text/plain".into(),
            local_path: path.clone(),
        };

        let id1 = rehost(&db, &import_id, "u1", &att).await.unwrap();
        // Same content under a different source id must dedup to the same file row.
        let att2 = SourceAttachment { discord_id: "a-2".into(), local_path: path, ..att.clone() };
        let id2 = rehost(&db, &import_id, "u1", &att2).await.unwrap();
        assert_eq!(id1, id2);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files").fetch_one(&db).await.unwrap();
        assert_eq!(count, 1);
    }
}
```

Add `pub mod attachments;` to `server/src/import/mod.rs`.

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::attachments`
Expected: PASS.

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/attachments.rs server/src/import/mod.rs
git commit -m "feat(import): re-host attachments into content-addressed file store"
```

---

### Task 9: Role mapping (conservative: name + color, no permissions)

**Files:**
- Modify: `server/src/import/mapper.rs`

**Interfaces:**
- Consumes: `model::SourceRole`, provenance helpers.
- Produces: `mapper::map_role(db, import_id, server_id, r: &SourceRole) -> anyhow::Result<String>`.

**Rationale (do not "improve" this into auto-granting permissions):** Discord permission bits do not map cleanly onto Ohiyo's, and *over*-granting on import is a privilege-escalation risk. Phase 1 deliberately imports roles with `permissions = 0` and lets the orchestrator flag every role for manual review in the report. Faithful bit-mapping is a later, security-reviewed task.

- [ ] **Step 1: Write the failing test**

Append to `mapper.rs` (add `use super::model::SourceRole;`):

```rust
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
```

Append to `tests`:

```rust
#[tokio::test]
async fn role_imports_with_zero_permissions() {
    let db = test_db().await;
    let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
    let r = SourceRole { discord_id: "r-1".into(), name: "Mod".into(), color: Some("#f50".into()) };
    let rid = map_role(&db, &import_id, "s1", &r).await.unwrap();
    let perms: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(&rid).fetch_one(&db).await.unwrap();
    assert_eq!(perms, 0);
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && cargo test --lib import::mapper::tests::role_imports`
Expected: PASS.

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/mapper.rs
git commit -m "feat(import): map roles name+color with zero permissions (review-flagged)"
```

---

### Task 10: Import report

**Files:**
- Create: `server/src/import/report.rs`
- Modify: `server/src/import/mod.rs` (add `pub mod report;`)

**Interfaces:**
- Produces: `report::ImportReport` (Serialize) with fields `categories: u32`, `channels: u32`, `authors: u32`, `messages: u32`, `reactions: u32`, `attachments: u32`, `roles_needing_review: Vec<String>`, `parked: Vec<String>`; methods `ImportReport::default()`, `note_parked(&mut self, &str)`, `flag_role_review(&mut self, &str)`.

- [ ] **Step 1: Write the failing test**

Create `server/src/import/report.rs`:

```rust
//! The transparency artifact every import returns: what mapped, what needs human
//! review, what was parked. Nothing is silently dropped.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportReport {
    pub categories: u32,
    pub channels: u32,
    pub authors: u32,
    pub messages: u32,
    pub reactions: u32,
    pub attachments: u32,
    /// Role names recreated name+color only — the operator must set permissions.
    pub roles_needing_review: Vec<String>,
    /// Human-readable notes for anything not faithfully representable in Ohiyo.
    pub parked: Vec<String>,
}

impl ImportReport {
    pub fn note_parked(&mut self, note: &str) {
        self.parked.push(note.to_string());
    }
    pub fn flag_role_review(&mut self, role_name: &str) {
        self.roles_needing_review.push(role_name.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_counts_and_notes() {
        let mut r = ImportReport::default();
        r.channels = 3;
        r.flag_role_review("Mod");
        r.note_parked("2 stickers dropped");
        assert_eq!(r.channels, 3);
        assert_eq!(r.roles_needing_review, vec!["Mod"]);
        assert_eq!(r.parked.len(), 1);
    }

    #[test]
    fn serializes_to_json() {
        let json = serde_json::to_string(&ImportReport::default()).unwrap();
        assert!(json.contains("\"messages\":0"));
    }
}
```

Add `pub mod report;` to `server/src/import/mod.rs`.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --lib import::report`
Expected: PASS (2 tests).

- [ ] **Step 3: Lint + format + commit**

```bash
cd server && cargo fmt && cargo clippy --lib -- -D warnings
git add server/src/import/report.rs server/src/import/mod.rs
git commit -m "feat(import): import transparency report"
```

---

### Task 11: Orchestrator — `run_import` end-to-end + resumability

**Files:**
- Modify: `server/src/import/mod.rs`

**Interfaces:**
- Consumes: every `mapper::*`, `attachments::rehost`, `report::ImportReport`, `model::{SourceGuild, ImportOptions, within_window}`, job lifecycle helpers.
- Produces:
  - `import::run_import(db, owner_id, guild: &SourceGuild, opts: ImportOptions) -> anyhow::Result<(String, ImportReport)>` — creates a NEW server (owner = `owner_id`), an import job, runs everything, returns `(server_id, report)`.
  - `import::run_import_into(db, import_id, server_id, owner_id, guild, opts, now) -> anyhow::Result<ImportReport>` — the resumable core (re-invoking with the same `import_id` produces no duplicates).

- [ ] **Step 1: Write the failing test**

Add to `server/src/import/mod.rs` (after the helper fns, before `#[cfg(test)]`). Add imports at the top: `use crate::types::Server; use model::{ImportOptions, SourceGuild, within_window}; use report::ImportReport;` (only what's used).

```rust
/// Create a fresh server owned by `owner_id`, then import `guild` into it.
pub async fn run_import(
    db: &SqlitePool,
    owner_id: &str,
    guild: &SourceGuild,
    opts: ImportOptions,
) -> Result<(String, ImportReport)> {
    let server_id = new_id();
    let now = now_unix();
    sqlx::query("INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)")
        .bind(&server_id)
        .bind(&guild.name)
        .bind(owner_id)
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

    for a in &guild.authors {
        mapper::map_author(db, import_id, a).await?;
        report.authors += 1;
    }
    for r in &guild.roles {
        mapper::map_role(db, import_id, server_id, r).await?;
        report.flag_role_review(&r.name);
    }
    for c in &guild.categories {
        mapper::map_category(db, import_id, server_id, c).await?;
        report.categories += 1;
    }
    for ch in &guild.channels {
        let channel_id = mapper::map_channel(db, import_id, server_id, ch).await?;
        report.channels += 1;
        for m in &ch.messages {
            if !within_window(m.created_at, opts.history, now) {
                continue;
            }
            // Resolve the author (must exist in guild.authors; skip+park if not).
            let author_id = match lookup_map(db, import_id, "user", &m.author_discord_id).await? {
                Some(id) => id,
                None => {
                    report.note_parked(&format!("message {} from unknown author", m.discord_id));
                    continue;
                }
            };
            // Re-host attachments, collect Ohiyo file ids into a JSON array.
            let mut file_ids: Vec<String> = Vec::new();
            for att in &m.attachments {
                file_ids.push(attachments::rehost(db, import_id, owner_id, att).await?);
                report.attachments += 1;
            }
            let attachments_json = if file_ids.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&file_ids)?)
            };
            let mid = mapper::map_message(
                db,
                import_id,
                &channel_id,
                &author_id,
                m,
                attachments_json.as_deref(),
            )
            .await?;
            report.messages += 1;
            for re in &m.reactions {
                if let Some(reactor) =
                    lookup_map(db, import_id, "user", &re.user_discord_id).await?
                {
                    mapper::map_reaction(db, &mid, &reactor, &re.emoji).await?;
                    report.reactions += 1;
                }
            }
        }
    }

    set_status(db, import_id, "complete").await?;
    Ok(report)
}
```

Add `use crate::types::Server;` only if used; in the code above `Server` is not used, so do NOT import it (avoid an unused-import clippy error). The needed extra imports are just `use model::{within_window, ImportOptions, SourceGuild};` and `use report::ImportReport;`.

Append a test to the existing `#[cfg(test)] mod tests` in `mod.rs`:

```rust
use super::mapper::author as _; // not needed; remove if present

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
        roles: vec![SourceRole { discord_id: "r-1".into(), name: "Mod".into(), color: None }],
        categories: vec![SourceCategory { discord_id: "c-1".into(), name: "Text".into(), position: 0 }],
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
                created_at: 1000,
                reply_to_discord_id: None,
                pinned: true,
                attachments: vec![],
                reactions: vec![SourceReaction { user_discord_id: "d-1".into(), emoji: "👍".into() }],
            }],
        }],
    }
}

#[tokio::test]
async fn run_import_populates_a_new_space() {
    let db = test_db().await;
    let opts = model::ImportOptions { history: model::HistoryWindow::All };
    let (server_id, report) = run_import(&db, "u1", &sample_guild(), opts).await.unwrap();

    assert_eq!(report.channels, 1);
    assert_eq!(report.messages, 1);
    assert_eq!(report.reactions, 1);
    assert_eq!(report.roles_needing_review, vec!["Mod"]);

    let msg_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?")
            .bind(&server_id).fetch_one(&db).await.unwrap();
    assert_eq!(msg_count, 1);

    let status: String = sqlx::query_scalar("SELECT status FROM discord_imports WHERE server_id = ?")
        .bind(&server_id).fetch_one(&db).await.unwrap();
    assert_eq!(status, "complete");
}

#[tokio::test]
async fn resuming_the_same_import_creates_no_duplicates() {
    let db = test_db().await;
    let guild = sample_guild();
    let opts = model::ImportOptions { history: model::HistoryWindow::All };

    // First run via the public entry, then re-run the resumable core with the SAME ids.
    let (server_id, _) = run_import(&db, "u1", &guild, opts).await.unwrap();
    let import_id: String =
        sqlx::query_scalar("SELECT id FROM discord_imports WHERE server_id = ?")
            .bind(&server_id).fetch_one(&db).await.unwrap();
    run_import_into(&db, &import_id, &server_id, "u1", &guild, opts, now_unix())
        .await.unwrap();

    let msg_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages").fetch_one(&db).await.unwrap();
    assert_eq!(msg_count, 1, "re-run must not duplicate messages");
}

#[tokio::test]
async fn ninety_day_window_skips_old_messages() {
    let db = test_db().await;
    let mut guild = sample_guild();
    guild.channels[0].messages[0].created_at = 1; // ancient
    let opts = model::ImportOptions { history: model::HistoryWindow::Last90Days };
    let (_sid, report) = run_import(&db, "u1", &guild, opts).await.unwrap();
    assert_eq!(report.messages, 0, "message older than 90 days must be skipped");
}
```

Remove the stray `use super::mapper::author as _;` line shown above — it was illustrative; the test references types via `model::*` and the sibling `mapper`/`attachments` fns through `run_import`. Ensure the test module has `use super::*;` at its top (Task 1 created it with that).

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --lib import`
Expected: PASS (all import tests across the module — Tasks 1–11).

- [ ] **Step 3: Full gate (matches CI)**

Run: `cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/import/mod.rs
git commit -m "feat(import): run_import orchestrator (idempotent, resumable, windowed)"
```

---

## What Phase 1 deliberately leaves for later

- **The discrawl reader** (`SourceGuild` ← real discrawl SQLite). Requires inspecting a real discrawl DB's schema (`sqlite3 <db> .schema`) to map its tables/columns; guessing now would violate the no-placeholder rule. This is **Task 1 of the Phase 2 plan**, where a real discrawl run exists to verify against. The `SourceGuild` contract defined here is exactly the boundary it targets.
- **Connect flow + preview + run orchestration + progress UX** (spec §10 phases 2–3): Discord OAuth bot invite, the dry-run preview with counts + history-depth choice, executing discrawl as a one-shot containerized job, the progress view, the "not E2E" badge (reads the `channels.imported` column added here), and rendering the `ImportReport`.
- **Member data-removal** (delete-by-ghost-author) and **emoji static-image import** (spec §11): build alongside the Phase 2 UI.

## Self-Review

**Spec coverage (spec §4 mapping table + §5.2 importer requirements):**
- Categories → Task 4 ✅ · Text/voice channels → Task 5 ✅ · Messages (author/ts/content/reply/pinned) → Task 6 ✅ · Attachments re-hosted → Task 8 ✅ · Reactions → Task 7 ✅ · Roles best-effort + report flag → Task 9 ✅ · Ghost authors display-only → Task 3 ✅ · Idempotent+resumable (snowflake-keyed) → Tasks 1, 11 ✅ · Import report → Tasks 10, 11 ✅ · `imported` not-E2E marker → Task 1 (column) + Task 5 (set) ✅ · History window (All/Last 90 days) → Tasks 2, 11 ✅.
- Threads: the model treats a thread as a channel (Phase 2's reader flattens Discord threads into `SourceChannel`s under their parent's category). No Phase 1 task gap — the mapper handles any `SourceChannel`. Noted here so it isn't mistaken for a miss.
- Deferred items (discrawl reader, OAuth/preview/UX, member-removal, emoji images) are explicitly listed above, not silently dropped.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The two illustrative-then-removed lines in Task 11 are called out with explicit removal instructions, not left as placeholders.

**Type consistency:** `map_author/map_category/map_channel/map_message/map_reaction/map_role` (mapper), `rehost` (attachments), `create_import/set_status/record_map/lookup_map/run_import/run_import_into` (mod), `ImportReport` fields, and `SourceGuild` shape are referenced identically across Tasks 1–11. Entity-type strings (`"user"`,`"role"`,`"category"`,`"channel"`,`"message"`,`"attachment"`) are consistent between every `record_map` and its paired `lookup_map`.
