//! S-M7: a poll lands as a message, so it obeys the same rules as one. The question has
//! the message byte cap (4000), each option is at most 200 characters and there are at
//! most 10, a block between DM participants stops it, and in a channel with disappearing
//! messages it expires like any other message. Polls stay allowed in DMs.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

async fn open_dm(srv: &TestServer, from: &AuthOk, to: &AuthOk) -> String {
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &from.token,
            json!({ "recipient_id": to.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    dm["id"].as_str().unwrap().to_owned()
}

async fn create_poll(
    srv: &TestServer,
    token: &str,
    channel_id: &str,
    question: &str,
    options: &[String],
) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel_id}/polls"),
        token,
        json!({ "question": question, "options": options }),
    )
    .await
}

fn options(n: usize, text: &str) -> Vec<String> {
    (0..n).map(|i| format!("{text}{i}")).collect()
}

#[tokio::test]
async fn poll_text_obeys_message_and_option_limits() {
    let srv = TestServer::start().await;
    let alice = srv.register("pollalice", "password123").await;
    let bob = srv.register("pollbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let two = options(2, "o");

    // The question has the message byte cap: 2001 two-byte characters is 4002 bytes.
    let res = create_poll(&srv, &alice.token, &dm, &"é".repeat(2001), &two).await;
    assert_eq!(res.status(), 400, "question over 4000 bytes");
    let res = create_poll(&srv, &alice.token, &dm, &"a".repeat(4000), &two).await;
    assert_eq!(res.status(), 200, "question of exactly 4000 bytes");

    let res = create_poll(&srv, &alice.token, &dm, "q", &options(2, &"é".repeat(200))).await;
    assert_eq!(res.status(), 400, "option over 200 characters");
    let res = create_poll(&srv, &alice.token, &dm, "q", &options(2, &"é".repeat(199))).await;
    assert_eq!(res.status(), 200, "option of exactly 200 characters");

    let res = create_poll(&srv, &alice.token, &dm, "q", &options(11, "o")).await;
    assert_eq!(res.status(), 400, "more than 10 options");
}

#[tokio::test]
async fn a_block_stops_polls_in_a_dm() {
    let srv = TestServer::start().await;
    let alice = srv.register("pollalice", "password123").await;
    let bob = srv.register("pollbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;

    let res = srv
        .post_empty_auth(&format!("/api/v1/users/{}/block", alice.id), &bob.token)
        .await;
    assert!(res.status().is_success(), "bob blocks alice");

    let res = create_poll(&srv, &alice.token, &dm, "lunch?", &options(2, "o")).await;
    assert_eq!(res.status(), 403, "the blocked sender can't post a poll");
    let res = create_poll(&srv, &bob.token, &dm, "lunch?", &options(2, "o")).await;
    assert_eq!(res.status(), 403, "nor can the blocker");
}

#[tokio::test]
async fn polls_in_disappearing_channels_expire_like_messages() {
    let srv = TestServer::start().await;
    let alice = srv.register("pollalice", "password123").await;
    let bob = srv.register("pollbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/channels/{dm}/disappearing"),
            &alice.token,
            json!({ "seconds": 3600 }),
        )
        .await;
    assert!(res.status().is_success(), "turn on disappearing messages");

    let before = common::now_unix();
    let res = create_poll(&srv, &alice.token, &dm, "lunch?", &options(2, "o")).await;
    assert_eq!(res.status(), 200, "polls are still allowed in DMs");
    let poll: Value = res.json().await.unwrap();
    let expires_at = poll["expires_at"]
        .as_i64()
        .expect("the poll message carries an expiry");
    assert!((before + 3600..=common::now_unix() + 3600).contains(&expires_at));

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let stored: Option<i64> = sqlx::query_scalar("SELECT expires_at FROM messages WHERE id = ?")
        .bind(poll["id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(stored, Some(expires_at), "the stored message expires too");
}
