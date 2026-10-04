//! S-M9 follow-up: upload dedup hands identical bytes one file id, so a wipe can collect
//! the same id from many messages. Each distinct id must be reference-counted once, not
//! once per message (every count scans `messages`).
//!
//! sqlx reports each statement it runs as a `sqlx::query` tracing event, from its own
//! worker thread, so this binary installs a process-wide subscriber that counts the
//! reference-count statement. Its own binary, so nothing else runs under that subscriber.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};

use common::{multipart_file, TestServer};
use serde_json::{json, Value};
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, SubscriberExt};

/// A fragment found only in the file reference-count statement.
const REFERENCE_SCAN: &str = "instr(attachments";

static REFERENCE_SCANS: AtomicUsize = AtomicUsize::new(0);

struct CountReferenceScans;

struct MentionsReferenceScan(bool);

impl Visit for MentionsReferenceScan {
    fn record_str(&mut self, _: &Field, value: &str) {
        self.0 |= value.contains(REFERENCE_SCAN);
    }

    fn record_debug(&mut self, _: &Field, value: &dyn std::fmt::Debug) {
        self.0 |= format!("{value:?}").contains(REFERENCE_SCAN);
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CountReferenceScans {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" {
            return;
        }
        let mut mentions = MentionsReferenceScan(false);
        event.record(&mut mentions);
        if mentions.0 {
            REFERENCE_SCANS.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[tokio::test]
async fn a_wipe_counts_references_once_per_distinct_file() {
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(CountReferenceScans),
    )
    .expect("install the counting subscriber");
    let dir = std::env::temp_dir().join(format!("ohiyo-refscan-{}", uuid::Uuid::new_v4()));
    std::env::set_var("OHIYO_UPLOAD_DIR", &dir);
    let srv = TestServer::start().await;
    let alice = srv.register("refscanalice", "password123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Scans" }))
        .await
        .json()
        .await
        .unwrap();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_owned();

    // One file, attached to five messages.
    let (content_type, body) = multipart_file("file", "pic.png", "image/png", b"one shared blob");
    let files: Value = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await
        .json()
        .await
        .unwrap();
    let file_id = files[0]["id"].as_str().unwrap().to_owned();
    for _ in 0..5 {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &alice.token,
                json!({ "content": "again", "attachment_ids": [file_id] }),
            )
            .await;
        assert_eq!(res.status(), 200);
    }

    // Trip Alice's dead-man's switch so the sweep wipes her five messages at once.
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/deadman",
            &alice.token,
            json!({ "seconds": 3600 }),
        )
        .await;
    assert_eq!(res.status(), 204);
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
        .bind(common::now_unix() - 7200)
        .bind(&alice.id)
        .execute(&db)
        .await
        .unwrap();

    REFERENCE_SCANS.store(0, Ordering::SeqCst);
    server::api::users::sweep_deadman(&srv.state).await;

    assert_eq!(
        srv.get(&format!("/files/{file_id}")).await.status(),
        404,
        "the wipe released the file"
    );
    assert_eq!(
        REFERENCE_SCANS.load(Ordering::SeqCst),
        1,
        "one reference count for the one distinct file"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
