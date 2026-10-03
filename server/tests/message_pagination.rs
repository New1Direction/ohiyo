//! Message history paging. S-M6: `limit` is clamped to 1..=100, so a zero or negative
//! limit can't return the whole channel. S-M14: `created_at` has whole-second resolution,
//! so the `before` cursor breaks ties by insertion order (rowid); walking back page by
//! page returns every message exactly once, even when many share one second.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

async fn channel_with_messages(srv: &TestServer, owner: &AuthOk, count: usize) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Paging" }))
        .await
        .json()
        .await
        .unwrap();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_owned();
    for i in 0..count {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &owner.token,
                json!({ "content": format!("message {i}") }),
            )
            .await;
        assert_eq!(res.status(), 200);
    }
    channel_id
}

async fn page(srv: &TestServer, token: &str, channel_id: &str, query: &str) -> Vec<Value> {
    let res = srv
        .get_auth(
            &format!("/api/v1/channels/{channel_id}/messages?{query}"),
            token,
        )
        .await;
    assert_eq!(res.status(), 200, "{query}");
    res.json::<Vec<Value>>().await.unwrap()
}

#[tokio::test]
async fn zero_and_negative_limits_return_one_message() {
    let srv = TestServer::start().await;
    let owner = srv.register("pageowner", "password123").await;
    let channel_id = channel_with_messages(&srv, &owner, 3).await;

    for limit in ["-1", "0"] {
        let got = page(&srv, &owner.token, &channel_id, &format!("limit={limit}")).await;
        assert_eq!(got.len(), 1, "limit={limit} is clamped to 1");
    }
    assert_eq!(
        page(&srv, &owner.token, &channel_id, "limit=2").await.len(),
        2
    );
}

#[tokio::test]
async fn walking_back_returns_same_second_messages_once_in_insertion_order() {
    let srv = TestServer::start().await;
    let owner = srv.register("pageowner", "password123").await;
    let channel_id = channel_with_messages(&srv, &owner, 0).await;

    // Six messages in one second, inserted in order; their ids are random UUIDs.
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let second = common::now_unix() - 60;
    let mut inserted = Vec::new();
    for i in 0..6 {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, channel_id, author_id, content, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&channel_id)
        .bind(&owner.id)
        .bind(format!("same second {i}"))
        .bind(second)
        .execute(&db)
        .await
        .unwrap();
        inserted.push(id);
    }

    // Each page is oldest-first; the next page asks for messages before its oldest.
    let mut walked: Vec<String> = Vec::new();
    let mut query = "limit=2".to_owned();
    loop {
        let got = page(&srv, &owner.token, &channel_id, &query).await;
        if got.is_empty() {
            break;
        }
        assert!(got.len() <= 2);
        let ids: Vec<String> = got
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_owned())
            .collect();
        query = format!("limit=2&before={}", ids[0]);
        walked.splice(0..0, ids);
        assert!(walked.len() <= 6, "the walk repeats messages: {walked:?}");
    }
    assert_eq!(walked, inserted, "all six, once each, in insertion order");
}
