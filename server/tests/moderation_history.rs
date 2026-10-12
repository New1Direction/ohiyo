//! Deleting an account used to take its bans, moderation actions and reports with it (ON
//! DELETE CASCADE): a space owner who left lifted every ban they had issued, and a
//! moderator could wipe the log of what they did. The account's id is cleared instead,
//! and the rows stay.

mod common;

use std::borrow::Cow;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};

const PASS: &str = "supersecret123";

async fn invite_and_join(srv: &TestServer, inviter: &AuthOk, server_id: &str, who: &AuthOk) -> u16 {
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &inviter.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    srv.post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_ban_outlives_the_account_that_issued_it() {
    let srv = TestServer::start().await;
    let owner = srv.register("banowner", PASS).await;
    let heir = srv.register("banheir", PASS).await;
    let spammer = srv.register("banspammer", PASS).await;
    let space: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Kept" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = space["id"].as_str().unwrap().to_owned();
    assert_eq!(invite_and_join(&srv, &owner, &server_id, &heir).await, 200);
    assert_eq!(
        invite_and_join(&srv, &owner, &server_id, &spammer).await,
        200
    );
    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/bans/{}", spammer.id),
            &owner.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 204, "ban");

    // The owner deletes their account; the space goes to the heir.
    let res = srv
        .client
        .delete(srv.url("/api/v1/users/@me"))
        .bearer_auth(&owner.token)
        .json(&json!({ "password": PASS, "username": "banowner" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    // The spammer can't come back with an invite from the new owner.
    assert_eq!(
        invite_and_join(&srv, &heir, &server_id, &spammer).await,
        403,
        "the ban still holds"
    );
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let logged: (i64, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*), MAX(actor_id) FROM moderation_actions WHERE target_id = ?",
    )
    .bind(&spammer.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(logged.0 >= 1, "the ban stays in the moderation log");
    assert_eq!(logged.1, None, "by an account that no longer exists");
}

/// The migration rebuilds three tables: a database from before it keeps every row and
/// every link between them.
#[tokio::test]
async fn bans_reports_and_the_log_survive_the_upgrade() {
    let path = std::env::temp_dir().join(format!("ohiyo-upgrade-{}.db", uuid::Uuid::new_v4()));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePool::connect_with(options).await.unwrap();
    let all = sqlx::migrate!("./migrations");
    let before = sqlx::migrate::Migrator {
        migrations: Cow::Owned(
            all.migrations
                .iter()
                .filter(|m| m.version < 44)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    before.run(&pool).await.unwrap();

    for id in ["owner", "moderator", "spammer", "reporter"] {
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, created_at)
             VALUES (?, ?, ?, 'x', 1)",
        )
        .bind(id)
        .bind(id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    for sql in [
        "INSERT INTO servers (id, name, owner_id, created_at) VALUES ('s1', 'Space', 'owner', 1)",
        "INSERT INTO server_bans (server_id, user_id, banned_by, banned_at)
         VALUES ('s1', 'spammer', 'moderator', 2)",
        "INSERT INTO abuse_reports (id, reporter_id, target_type, target_id, server_id, reason, created_at)
         VALUES ('r1', 'reporter', 'user', 'spammer', 's1', 'spam', 3)",
        "INSERT INTO moderation_actions (id, server_id, actor_id, action, target_type, target_id, report_id, created_at)
         VALUES ('a1', 's1', 'moderator', 'ban', 'user', 'spammer', 'r1', 4)",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }

    all.run(&pool).await.unwrap();

    let ban: (String, Option<String>, i64) = sqlx::query_as(
        "SELECT user_id, banned_by, banned_at FROM server_bans WHERE server_id = 's1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ban, ("spammer".into(), Some("moderator".into()), 2));
    let action: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT actor_id, report_id FROM moderation_actions WHERE id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        action,
        (Some("moderator".into()), Some("r1".into())),
        "the link to the report survives"
    );
    let problems: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
    assert!(problems.is_empty(), "foreign keys still hold: {problems:?}");
    let indexes: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'
           AND tbl_name IN ('abuse_reports', 'moderation_actions')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 6, "every index is back: {indexes:?}");

    // And now deleting the people who acted keeps what they did.
    sqlx::query("DELETE FROM users WHERE id IN ('moderator', 'reporter')")
        .execute(&pool)
        .await
        .unwrap();
    let kept: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM server_bans), (SELECT COUNT(*) FROM abuse_reports),
                (SELECT COUNT(*) FROM moderation_actions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, (1, 1, 1));
    pool.close().await;
    let _ = std::fs::remove_file(&path);
}
