//! The disk guard: uploads live on the same volume as the database, so once the disk is
//! down to its reserve (`MIN_FREE_DISK_BYTES`) an upload is refused with 507 and nothing
//! is stored, and the database keeps the room it needs to write.

mod common;

use common::{multipart_file, TestServer};

async fn stored_files(srv: &TestServer) -> i64 {
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM files")
        .fetch_one(&db)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_upload_is_refused_while_the_disk_is_down_to_its_reserve() {
    // A reserve bigger than any disk: there is never room to spare.
    let srv = TestServer::start_with(|state| state.min_free_disk_bytes = u64::MAX).await;
    let alice = srv.register("alice", "password123").await;

    let (content_type, body) =
        multipart_file("file", "note.txt", "text/plain", b"hello from a full disk");
    let res = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await;

    assert_eq!(res.status(), 507, "a full disk must refuse the upload");
    let text = res.text().await.unwrap();
    assert_eq!(
        text,
        "Ohiyo is short on storage right now. Try again later."
    );
    assert_eq!(stored_files(&srv).await, 0, "nothing may be stored");
}

#[tokio::test]
async fn uploads_go_through_when_the_guard_is_off() {
    let srv = TestServer::start_with(|state| state.min_free_disk_bytes = 0).await;
    let alice = srv.register("alice", "password123").await;

    let (content_type, body) = multipart_file("file", "note.txt", "text/plain", b"plenty of room");
    let res = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await;

    assert_eq!(res.status(), 200);
    assert_eq!(stored_files(&srv).await, 1);
}
