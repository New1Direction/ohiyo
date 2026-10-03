//! S-M9: when a message goes (deleted, expired, or wiped by the dead-man's switch), each
//! attached file goes with it, but only once nothing else references that file: no
//! other message attachment (either JSON shape), avatar, banner, server icon or emoji.
//! Upload dedup hands identical bytes the same file id, so references are counted.

mod common;

use std::sync::Once;

use common::{multipart_file, AuthOk, TestServer};
use serde_json::{json, Value};

static ENV: Once = Once::new();

/// One private upload dir for this binary, and a base URL for avatar/banner/icon URLs.
/// Every test uploads unique bytes, so no two tests (or their DBs) share a blob.
fn init_env() {
    ENV.call_once(|| {
        let dir = std::env::temp_dir().join(format!("ohiyo-cleanup-{}", uuid::Uuid::new_v4()));
        std::env::set_var("OHIYO_UPLOAD_DIR", dir);
        std::env::set_var("PUBLIC_BASE_URL", "http://localhost:3000");
    });
}

struct World {
    srv: TestServer,
    db: sqlx::SqlitePool,
    alice: AuthOk,
    server_id: String,
    channel_id: String,
}

async fn world() -> World {
    init_env();
    let srv = TestServer::start().await;
    let alice = srv.register("cleanupalice", "supersecret123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Files" }))
        .await
        .json()
        .await
        .unwrap();
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    World {
        server_id: server["id"].as_str().unwrap().to_owned(),
        channel_id: server["channels"][0]["id"].as_str().unwrap().to_owned(),
        srv,
        db,
        alice,
    }
}

fn unique_bytes() -> Vec<u8> {
    format!("blob {}", uuid::Uuid::new_v4()).into_bytes()
}

async fn upload(w: &World, bytes: &[u8]) -> String {
    let (content_type, body) = multipart_file("file", "pic.png", "image/png", bytes);
    let res = w
        .srv
        .post_raw_auth("/api/v1/upload", &w.alice.token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "upload");
    let files: Value = res.json().await.unwrap();
    files[0]["id"].as_str().unwrap().to_owned()
}

async fn send(w: &World, file_id: &str) -> String {
    let res = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/messages", w.channel_id),
            &w.alice.token,
            json!({ "content": "see attached", "attachment_ids": [file_id] }),
        )
        .await;
    assert_eq!(res.status(), 200, "send with attachment");
    let msg: Value = res.json().await.unwrap();
    msg["id"].as_str().unwrap().to_owned()
}

async fn delete_message(w: &World, message_id: &str) {
    let res = w
        .srv
        .delete_auth(
            &format!("/api/v1/channels/{}/messages/{message_id}", w.channel_id),
            &w.alice.token,
        )
        .await;
    assert_eq!(res.status(), 204, "delete message");
}

async fn file_status(w: &World, file_id: &str) -> u16 {
    w.srv
        .get(&format!("/files/{file_id}"))
        .await
        .status()
        .as_u16()
}

async fn blob_path(w: &World, file_id: &str) -> std::path::PathBuf {
    let path: String = sqlx::query_scalar("SELECT path FROM files WHERE id = ?")
        .bind(file_id)
        .fetch_one(&w.db)
        .await
        .unwrap();
    path.into()
}

#[tokio::test]
async fn deleting_the_only_message_removes_its_file_and_blob() {
    let w = world().await;
    let file_id = upload(&w, &unique_bytes()).await;
    let message_id = send(&w, &file_id).await;
    let blob = blob_path(&w, &file_id).await;
    assert_eq!(file_status(&w, &file_id).await, 200);

    delete_message(&w, &message_id).await;

    assert_eq!(file_status(&w, &file_id).await, 404);
    assert!(!blob.exists(), "the blob is removed from disk");
}

#[tokio::test]
async fn a_file_shared_by_two_messages_goes_with_the_second() {
    let w = world().await;
    let bytes = unique_bytes();
    let first_upload = upload(&w, &bytes).await;
    let second_upload = upload(&w, &bytes).await;
    assert_eq!(
        first_upload, second_upload,
        "identical bytes dedup to one file"
    );
    let first = send(&w, &first_upload).await;
    let second = send(&w, &second_upload).await;
    let blob = blob_path(&w, &first_upload).await;

    delete_message(&w, &first).await;
    assert_eq!(
        file_status(&w, &first_upload).await,
        200,
        "still attached to the second message"
    );
    assert!(blob.exists());

    delete_message(&w, &second).await;
    assert_eq!(file_status(&w, &first_upload).await, 404);
    assert!(!blob.exists());
}

#[tokio::test]
async fn files_still_used_elsewhere_survive_and_import_shaped_references_count() {
    let w = world().await;

    // One file per kind of non-message reference.
    let avatar = upload(&w, &unique_bytes()).await;
    let banner = upload(&w, &unique_bytes()).await;
    let icon = upload(&w, &unique_bytes()).await;
    let emoji = upload(&w, &unique_bytes()).await;
    for (path, body) in [
        (
            "/api/v1/users/@me/avatar".to_owned(),
            json!({ "file_id": avatar }),
        ),
        (
            "/api/v1/users/@me/banner".to_owned(),
            json!({ "file_id": banner }),
        ),
        (
            format!("/api/v1/servers/{}/icon", w.server_id),
            json!({ "file_id": icon }),
        ),
        (
            format!("/api/v1/servers/{}/emojis", w.server_id),
            json!({ "name": "kept", "file_id": emoji }),
        ),
    ] {
        let res = w.srv.post_json_auth(&path, &w.alice.token, body).await;
        assert!(res.status().is_success(), "{path}: {}", res.status());
    }
    for file_id in [&avatar, &banner, &icon, &emoji] {
        let message_id = send(&w, file_id).await;
        delete_message(&w, &message_id).await;
        assert_eq!(
            file_status(&w, file_id).await,
            200,
            "a file still in use outside messages survives"
        );
    }

    // Discord-imported messages store attachments as bare ids: ["<id>"].
    let shared = upload(&w, &unique_bytes()).await;
    let native = send(&w, &shared).await;
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, attachments)
         VALUES ('imported-msg', ?, ?, 'imported', 1, ?)",
    )
    .bind(&w.channel_id)
    .bind(&w.alice.id)
    .bind(json!([shared]).to_string())
    .execute(&w.db)
    .await
    .unwrap();
    delete_message(&w, &native).await;
    assert_eq!(
        file_status(&w, &shared).await,
        200,
        "an imported message's bare-id reference keeps the file"
    );
    delete_message(&w, "imported-msg").await;
    assert_eq!(
        file_status(&w, &shared).await,
        404,
        "deleting the imported message releases its bare-id attachment"
    );
}

#[tokio::test]
async fn expired_messages_take_their_files() {
    let w = world().await;
    let file_id = upload(&w, &unique_bytes()).await;
    let message_id = send(&w, &file_id).await;
    sqlx::query("UPDATE messages SET expires_at = 1 WHERE id = ?")
        .bind(&message_id)
        .execute(&w.db)
        .await
        .unwrap();

    server::api::messages::sweep_expired(&w.srv.state).await;

    assert_eq!(file_status(&w, &file_id).await, 404);
}

#[tokio::test]
async fn dead_man_wipe_takes_the_users_files() {
    let w = world().await;
    let file_id = upload(&w, &unique_bytes()).await;
    send(&w, &file_id).await;
    let res = w
        .srv
        .post_json_auth(
            "/api/v1/users/@me/deadman",
            &w.alice.token,
            json!({ "seconds": 3600 }),
        )
        .await;
    assert_eq!(res.status(), 204);
    sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
        .bind(common::now_unix() - 7200)
        .bind(&w.alice.id)
        .execute(&w.db)
        .await
        .unwrap();

    server::api::users::sweep_deadman(&w.srv.state).await;

    assert_eq!(file_status(&w, &file_id).await, 404);
}
