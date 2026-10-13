//! Catching up, like Discord: "Mark as read" on a channel, "Mark space as read" and
//! Shift+Esc mark many chats read in one request (`POST /users/@me/read`), up to the newest
//! message in each, but only chats you can read. Your other open devices hear about every
//! read (that request or reading a chat on one device), so their unread numbers clear too.

mod common;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const PASS: &str = "supersecret123";

/// `owner` makes a space with #general and #random; `member` joins. Returns (space, general, random).
async fn space(srv: &TestServer, owner: &AuthOk, member: &AuthOk) -> (String, String, String) {
    let server: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Catch up" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let general = server["channels"][0]["id"].as_str().unwrap().to_owned();
    let random: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &owner.token,
            json!({ "name": "random" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let random = random["id"].as_str().unwrap().to_owned();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    assert_eq!(
        srv.post_json_auth(&format!("/api/v1/invites/{code}"), &member.token, json!({}))
            .await
            .status(),
        200
    );
    (server_id, general, random)
}

async fn say(srv: &TestServer, token: &str, channel_id: &str, content: &str) -> String {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            token,
            json!({ "content": content }),
        )
        .await;
    assert_eq!(res.status(), 200, "send to {channel_id}");
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_owned()
}

async fn mark_read(srv: &TestServer, token: &str, ids: &[&str]) -> reqwest::Response {
    srv.post_json_auth(
        "/api/v1/users/@me/read",
        token,
        json!({ "channel_ids": ids }),
    )
    .await
}

fn read_ids(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body["reads"]
        .as_array()
        .expect("the answer lists the reads")
        .iter()
        .map(|r| r["channel_id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

async fn unread_on_connect(srv: &TestServer, token: &str) -> Value {
    let mut gw = Gateway::connect(srv, token).await;
    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;
    ready["d"]["unread"].clone()
}

#[tokio::test]
async fn marking_chats_read_clears_their_unread_for_good() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner", PASS).await;
    let member = srv.register("cumember", PASS).await;
    let (_space, general, random) = space(&srv, &owner, &member).await;
    say(&srv, &owner.token, &general, "one").await;
    say(&srv, &owner.token, &general, "two").await;
    say(&srv, &owner.token, &random, "three").await;

    let before = unread_on_connect(&srv, &member.token).await;
    assert_eq!(before[&general], 2);
    assert_eq!(before[&random], 1);

    let res = mark_read(&srv, &member.token, &[&general, &random]).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let mut expected = vec![general.clone(), random.clone()];
    expected.sort();
    assert_eq!(read_ids(&body), expected);

    let after = unread_on_connect(&srv, &member.token).await;
    assert!(
        after.get(&general).is_none(),
        "#general has nothing unread: {after}"
    );
    assert!(
        after.get(&random).is_none(),
        "#random has nothing unread: {after}"
    );
}

#[tokio::test]
async fn chats_you_cant_read_are_left_alone() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner2", PASS).await;
    let member = srv.register("cumember2", PASS).await;
    let stranger = srv.register("custranger2", PASS).await;
    let (_space, general, _random) = space(&srv, &owner, &member).await;
    say(&srv, &owner.token, &general, "hello").await;

    // A space the member isn't in, and a DM between two other people.
    let elsewhere: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &stranger.token,
            json!({ "name": "Elsewhere" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let elsewhere_general = elsewhere["channels"][0]["id"].as_str().unwrap().to_owned();
    say(&srv, &stranger.token, &elsewhere_general, "not for you").await;
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &owner.token,
            json!({ "recipient_id": stranger.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let dm_id = dm["id"].as_str().unwrap().to_owned();
    say(&srv, &stranger.token, &dm_id, "private").await;

    let res = mark_read(
        &srv,
        &member.token,
        &[&general, &elsewhere_general, &dm_id, "no-such-channel"],
    )
    .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        read_ids(&body),
        vec![general.clone()],
        "only the chat the member can read"
    );

    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channel_reads WHERE user_id = ? AND channel_id IN (?, ?)",
    )
    .bind(&member.id)
    .bind(&elsewhere_general)
    .bind(&dm_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 0, "no read mark in chats the member can't see");
}

#[tokio::test]
async fn an_empty_chat_has_nothing_to_mark() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner3", PASS).await;
    let member = srv.register("cumember3", PASS).await;
    let (_space, general, random) = space(&srv, &owner, &member).await;
    say(&srv, &owner.token, &general, "only here").await;

    let res = mark_read(&srv, &member.token, &[&general, &random]).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(read_ids(&body), vec![general.clone()]);
}

#[tokio::test]
async fn your_other_devices_hear_about_it() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner4", PASS).await;
    let member = srv.register("cumember4", PASS).await;
    let (_space, general, _random) = space(&srv, &owner, &member).await;
    let newest = say(&srv, &owner.token, &general, "news").await;

    let mut other_device = Gateway::connect(&srv, &member.token).await;
    other_device.wait_for(|ev| ev["t"] == "Ready").await;
    assert_eq!(
        mark_read(&srv, &member.token, &[&general]).await.status(),
        200
    );
    let update = other_device
        .wait_for(|ev| ev["t"] == "ReadStateUpdate")
        .await;
    let read = &update["d"]["reads"][0];
    assert_eq!(read["channel_id"], general);
    assert_eq!(read["last_read_message_id"], newest);
}

#[tokio::test]
async fn reading_a_chat_on_one_device_clears_it_on_the_others() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner5", PASS).await;
    let member = srv.register("cumember5", PASS).await;
    let (_space, general, _random) = space(&srv, &owner, &member).await;
    let newest = say(&srv, &owner.token, &general, "news").await;

    let mut phone = Gateway::connect(&srv, &member.token).await;
    phone.wait_for(|ev| ev["t"] == "Ready").await;
    let mut desktop = Gateway::connect(&srv, &member.token).await;
    desktop.wait_for(|ev| ev["t"] == "Ready").await;
    desktop
        .send(&json!({ "t": "Ack", "d": { "channel_id": general, "message_id": newest } }))
        .await;
    let update = phone.wait_for(|ev| ev["t"] == "ReadStateUpdate").await;
    assert_eq!(update["d"]["reads"][0]["channel_id"], general);
}

#[tokio::test]
async fn too_many_chats_or_too_many_requests_are_refused() {
    let srv = TestServer::start().await;
    let owner = srv.register("cuowner6", PASS).await;
    let member = srv.register("cumember6", PASS).await;
    let (_space, general, _random) = space(&srv, &owner, &member).await;
    say(&srv, &owner.token, &general, "x").await;

    let many: Vec<String> = (0..201).map(|i| format!("channel-{i}")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    assert_eq!(mark_read(&srv, &member.token, &many).await.status(), 400);

    let mut refused = false;
    for _ in 0..40 {
        if mark_read(&srv, &member.token, &[&general]).await.status() == 429 {
            refused = true;
            break;
        }
    }
    assert!(refused, "marking read is rate limited");
}
