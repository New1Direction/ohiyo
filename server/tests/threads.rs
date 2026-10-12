//! Threads: a reply chain started from one message in a space's text channel. A thread is a
//! channel of its own (messages, reactions, pins and search all work as in any channel) that
//! hangs off its parent channel: it takes the parent's permissions, it stays out of the
//! channel list, and it goes when the parent goes. Threads are for spaces only; DMs and
//! group chats are end-to-end encrypted and have none.

mod common;

use std::time::Duration;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

const VIEW_CHANNEL: i64 = 1 << 6;

struct Space {
    id: String,
    general: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let body: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let general = body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Space {
        id: body["id"].as_str().unwrap().to_owned(),
        general,
    }
}

async fn join(srv: &TestServer, owner: &AuthOk, space: &Space, who: &AuthOk) {
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/invites", space.id),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "join");
}

async fn say(srv: &TestServer, who: &AuthOk, channel: &str, text: &str) -> Value {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel}/messages"),
            &who.token,
            json!({ "content": text }),
        )
        .await;
    assert_eq!(res.status(), 200, "send to {channel}");
    res.json().await.unwrap()
}

async fn start_thread(
    srv: &TestServer,
    who: &AuthOk,
    channel: &str,
    message_id: &str,
    name: &str,
) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel}/threads"),
        &who.token,
        json!({ "message_id": message_id, "name": name }),
    )
    .await
}

async fn threads_of(srv: &TestServer, who: &AuthOk, channel: &str) -> reqwest::Response {
    srv.get_auth(&format!("/api/v1/channels/{channel}/threads"), &who.token)
        .await
}

#[tokio::test]
async fn a_thread_starts_from_a_message_in_the_same_space() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_owner", "password123").await;
    let s = space(&srv, &owner, "Threads").await;
    let msg = say(&srv, &owner, &s.general, "who's up for a game tonight?").await;

    let res = start_thread(
        &srv,
        &owner,
        &s.general,
        msg["id"].as_str().unwrap(),
        "Game night",
    )
    .await;
    assert_eq!(res.status(), 200);
    let thread: Value = res.json().await.unwrap();
    assert_eq!(thread["name"], "Game night");
    assert_eq!(thread["server_id"], s.id.as_str());
    assert_eq!(thread["parent_id"], s.general.as_str());
    assert_eq!(thread["thread_message_id"], msg["id"]);
    assert_eq!(thread["message_count"], 0);
    assert_eq!(thread["starter_deleted"], false);

    // People talk in it like in any channel.
    let thread_id = thread["id"].as_str().unwrap();
    say(&srv, &owner, thread_id, "8pm?").await;
    let messages: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let texts: Vec<&str> = messages
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["8pm?"]);
}

#[tokio::test]
async fn a_message_has_at_most_one_thread() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_once", "password123").await;
    let s = space(&srv, &owner, "Once").await;
    let msg = say(&srv, &owner, &s.general, "one thread please").await;
    let message_id = msg["id"].as_str().unwrap();

    let first: Value = start_thread(&srv, &owner, &s.general, message_id, "First")
        .await
        .json()
        .await
        .unwrap();
    let again = start_thread(&srv, &owner, &s.general, message_id, "Second").await;
    assert_eq!(
        again.status(),
        200,
        "starting it again opens the same thread"
    );
    let again: Value = again.json().await.unwrap();
    assert_eq!(again["id"], first["id"]);
    assert_eq!(again["name"], "First");

    let list: Value = threads_of(&srv, &owner, &s.general)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn someone_outside_the_space_cant_start_or_see_threads() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_host", "password123").await;
    let outsider = srv.register("th_outsider", "password123").await;
    let s = space(&srv, &owner, "Closed").await;
    let msg = say(&srv, &owner, &s.general, "members only").await;
    let message_id = msg["id"].as_str().unwrap();

    let res = start_thread(&srv, &outsider, &s.general, message_id, "Nope").await;
    assert_eq!(res.status(), 403);
    let thread: Value = start_thread(&srv, &owner, &s.general, message_id, "Inside")
        .await
        .json()
        .await
        .unwrap();
    let thread_id = thread["id"].as_str().unwrap();

    assert_eq!(threads_of(&srv, &outsider, &s.general).await.status(), 403);
    assert_eq!(
        srv.get_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &outsider.token
        )
        .await
        .status(),
        403
    );
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &outsider.token,
            json!({ "content": "let me in" }),
        )
        .await;
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn a_thread_follows_its_parent_channels_permissions() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_perm_owner", "password123").await;
    let member = srv.register("th_perm_member", "password123").await;
    let s = space(&srv, &owner, "Perms").await;
    join(&srv, &owner, &s, &member).await;
    let msg = say(&srv, &owner, &s.general, "start here").await;
    let thread: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        msg["id"].as_str().unwrap(),
        "Side chat",
    )
    .await
    .json()
    .await
    .unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    say(&srv, &member, &thread_id, "I can talk here").await;

    // Hide the parent channel from @everyone: the thread goes with it.
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hide_parent', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&s.id)
    .bind(&s.general)
    .bind(VIEW_CHANNEL)
    .execute(&db)
    .await
    .unwrap();

    assert_eq!(
        srv.get_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &member.token
        )
        .await
        .status(),
        403,
        "a member who can't see the parent can't read its thread"
    );
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &member.token,
            json!({ "content": "still here?" }),
        )
        .await;
    assert_eq!(res.status(), 403);
    assert_eq!(threads_of(&srv, &member, &s.general).await.status(), 403);
    // The owner still sees it all.
    assert_eq!(
        srv.get_auth(
            &format!("/api/v1/channels/{thread_id}/messages"),
            &owner.token
        )
        .await
        .status(),
        200
    );
}

#[tokio::test]
async fn threads_are_listed_by_latest_activity_with_their_reply_counts() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_lister", "password123").await;
    let s = space(&srv, &owner, "Lists").await;
    let first = say(&srv, &owner, &s.general, "first topic").await;
    let second = say(&srv, &owner, &s.general, "second topic").await;
    let a: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        first["id"].as_str().unwrap(),
        "Older",
    )
    .await
    .json()
    .await
    .unwrap();
    let b: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        second["id"].as_str().unwrap(),
        "Busier",
    )
    .await
    .json()
    .await
    .unwrap();
    // The first thread gets a reply now, so it's the most recently active.
    let a_id = a["id"].as_str().unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    say(&srv, &owner, a_id, "reply one").await;
    say(&srv, &owner, a_id, "reply two").await;

    let list: Value = threads_of(&srv, &owner, &s.general)
        .await
        .json()
        .await
        .unwrap();
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(
        list[0]["id"], a["id"],
        "the thread with the latest reply comes first"
    );
    assert_eq!(list[0]["message_count"], 2);
    assert!(list[0]["last_message_at"].as_i64().is_some());
    assert_eq!(list[1]["id"], b["id"]);
    assert_eq!(list[1]["message_count"], 0);
    assert!(list[1]["last_message_at"].is_null());
}

#[tokio::test]
async fn deleting_the_first_message_keeps_the_thread() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_keeper", "password123").await;
    let s = space(&srv, &owner, "Keep").await;
    let msg = say(&srv, &owner, &s.general, "this will go").await;
    let message_id = msg["id"].as_str().unwrap();
    let thread: Value = start_thread(&srv, &owner, &s.general, message_id, "Survivor")
        .await
        .json()
        .await
        .unwrap();
    let thread_id = thread["id"].as_str().unwrap();
    say(&srv, &owner, thread_id, "the thread outlives it").await;

    let res = srv
        .delete_auth(
            &format!("/api/v1/channels/{}/messages/{message_id}", s.general),
            &owner.token,
        )
        .await;
    assert!(res.status().is_success(), "delete the first message");

    let list: Value = threads_of(&srv, &owner, &s.general)
        .await
        .json()
        .await
        .unwrap();
    let kept = &list.as_array().unwrap()[0];
    assert_eq!(kept["id"], thread["id"]);
    assert_eq!(kept["starter_deleted"], true);
    assert_eq!(kept["message_count"], 1);
}

#[tokio::test]
async fn deleting_the_channel_deletes_its_threads() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_cleaner", "password123").await;
    let s = space(&srv, &owner, "Clean").await;
    let extra: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/channels", s.id),
            &owner.token,
            json!({ "name": "temporary" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let extra_id = extra["id"].as_str().unwrap().to_owned();
    let msg = say(&srv, &owner, &extra_id, "short-lived").await;
    let thread: Value = start_thread(
        &srv,
        &owner,
        &extra_id,
        msg["id"].as_str().unwrap(),
        "Gone soon",
    )
    .await
    .json()
    .await
    .unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    say(&srv, &owner, &thread_id, "inside").await;

    let res = srv
        .delete_auth(&format!("/api/v1/channels/{extra_id}"), &owner.token)
        .await;
    assert_eq!(res.status(), 204);

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let left: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM channels WHERE id = ?1),
                (SELECT COUNT(*) FROM messages WHERE channel_id = ?1)",
    )
    .bind(&thread_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(left, (0, 0), "the thread and its messages are gone");
}

#[tokio::test]
async fn threads_stay_out_of_the_channel_list() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_sidebar", "password123").await;
    let s = space(&srv, &owner, "Sidebar").await;
    let msg = say(&srv, &owner, &s.general, "list check").await;
    let thread: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        msg["id"].as_str().unwrap(),
        "Not a channel",
    )
    .await
    .json()
    .await
    .unwrap();

    let full: Value = srv
        .get_auth(&format!("/api/v1/servers/{}", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    let ids: Vec<&str> = full["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&thread["id"].as_str().unwrap()));

    let channels: Value = srv
        .get_auth(&format!("/api/v1/servers/{}/channels", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(!channels
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == thread["id"]));
}

#[tokio::test]
async fn only_a_message_in_a_spaces_text_channel_can_start_a_thread() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_rules", "password123").await;
    let friend = srv.register("th_rules_friend", "password123").await;
    let s = space(&srv, &owner, "Rules").await;
    let msg = say(&srv, &owner, &s.general, "rules").await;
    let message_id = msg["id"].as_str().unwrap();

    // A message from another channel.
    let other: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/channels", s.id),
            &owner.token,
            json!({ "name": "other" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let other_id = other["id"].as_str().unwrap();
    assert_eq!(
        start_thread(&srv, &owner, other_id, message_id, "Wrong place")
            .await
            .status(),
        404
    );
    // A name that's too long.
    assert_eq!(
        start_thread(&srv, &owner, &s.general, message_id, &"x".repeat(101))
            .await
            .status(),
        400
    );
    // No thread inside a thread.
    let thread: Value = start_thread(&srv, &owner, &s.general, message_id, "Level one")
        .await
        .json()
        .await
        .unwrap();
    let thread_id = thread["id"].as_str().unwrap();
    let inner = say(&srv, &owner, thread_id, "deeper?").await;
    assert_eq!(
        start_thread(
            &srv,
            &owner,
            thread_id,
            inner["id"].as_str().unwrap(),
            "Level two"
        )
        .await
        .status(),
        400
    );
    // Not in a DM.
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &owner.token,
            json!({ "recipient_id": friend.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let dm_id = dm["id"].as_str().unwrap();
    let dm_msg = say(&srv, &owner, dm_id, "private").await;
    assert_eq!(
        start_thread(&srv, &owner, dm_id, dm_msg["id"].as_str().unwrap(), "No")
            .await
            .status(),
        400
    );
    // An empty name is fine: it comes from the message.
    let fresh = say(&srv, &owner, &s.general, "Plans for Saturday\nand more").await;
    let named: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        fresh["id"].as_str().unwrap(),
        "  ",
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(named["name"], "Plans for Saturday");
}

#[tokio::test]
async fn people_watching_the_channel_hear_about_threads_and_replies() {
    let srv = TestServer::start().await;
    let owner = srv.register("th_live_owner", "password123").await;
    let member = srv.register("th_live_member", "password123").await;
    let s = space(&srv, &owner, "Live").await;
    join(&srv, &owner, &s, &member).await;
    let msg = say(&srv, &member, &s.general, "talk about it?").await;

    let mut gw = Gateway::connect(&srv, &member.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    let thread: Value = start_thread(
        &srv,
        &owner,
        &s.general,
        msg["id"].as_str().unwrap(),
        "Talk",
    )
    .await
    .json()
    .await
    .unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    let created = tokio::time::timeout(
        Duration::from_secs(5),
        gw.wait_for(|e| e["t"] == "ThreadUpdate"),
    )
    .await
    .expect("the new thread is announced");
    assert_eq!(created["d"]["id"], thread_id.as_str());
    assert_eq!(created["d"]["message_count"], 0);

    say(&srv, &owner, &thread_id, "here we go").await;
    let replied = tokio::time::timeout(
        Duration::from_secs(5),
        gw.wait_for(|e| e["t"] == "ThreadUpdate" && e["d"]["message_count"] == 1),
    )
    .await
    .expect("the reply count is announced");
    assert_eq!(replied["d"]["id"], thread_id.as_str());
    assert!(replied["d"]["last_message_at"].as_i64().is_some());
}
