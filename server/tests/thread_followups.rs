//! Threads, the rest of the way to Discord's: whoever started a thread (or anyone who manages
//! the channel's messages or channels) can rename or delete it; you follow a thread when you
//! start it or reply in it, and can follow or unfollow it by hand; a followed thread counts as
//! unread and wakes your phone like a channel does, an unfollowed one only when it mentions
//! you; and a thread nobody has written in for a week shows as archived until someone does.

mod common;

use std::time::Duration;

use common::{multipart_file, ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const PASS: &str = "password123";
const WEEK: i64 = 7 * 24 * 60 * 60;

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

/// `who` starts a thread from a fresh message of theirs in #general. Returns the thread id.
async fn thread_by(srv: &TestServer, who: &AuthOk, s: &Space, name: &str) -> String {
    let msg = say(srv, who, &s.general, &format!("about {name}")).await;
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", s.general),
            &who.token,
            json!({ "message_id": msg["id"], "name": name }),
        )
        .await;
    assert_eq!(res.status(), 200, "start thread");
    let thread: Value = res.json().await.unwrap();
    thread["id"].as_str().unwrap().to_owned()
}

async fn listed(srv: &TestServer, who: &AuthOk, s: &Space, thread_id: &str) -> Option<Value> {
    let res = srv
        .get_auth(
            &format!("/api/v1/channels/{}/threads", s.general),
            &who.token,
        )
        .await;
    assert_eq!(res.status(), 200, "list threads");
    let list: Value = res.json().await.unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == thread_id)
        .cloned()
}

async fn rename(srv: &TestServer, who: &AuthOk, thread_id: &str, name: &str) -> u16 {
    srv.patch_json_auth(
        &format!("/api/v1/threads/{thread_id}"),
        &who.token,
        json!({ "name": name }),
    )
    .await
    .status()
    .as_u16()
}

async fn follow(srv: &TestServer, who: &AuthOk, thread_id: &str, on: bool) -> u16 {
    let path = format!("/api/v1/threads/{thread_id}/follow");
    let res = if on {
        srv.put_json_auth(&path, &who.token, json!({})).await
    } else {
        srv.delete_auth(&path, &who.token).await
    };
    res.status().as_u16()
}

/// The space owner and two members, all in one space.
async fn three(srv: &TestServer, tag: &str) -> (AuthOk, AuthOk, AuthOk, Space) {
    let owner = srv.register(&format!("tf_{tag}_own"), PASS).await;
    let ann = srv.register(&format!("tf_{tag}_ann"), PASS).await;
    let bo = srv.register(&format!("tf_{tag}_bo"), PASS).await;
    let s = space(srv, &owner, &format!("Followups {tag}")).await;
    join(srv, &owner, &s, &ann).await;
    join(srv, &owner, &s, &bo).await;
    (owner, ann, bo, s)
}

#[tokio::test]
async fn the_starter_or_a_manager_renames_a_thread_and_nobody_else_can() {
    let srv = TestServer::start().await;
    let (owner, ann, bo, s) = three(&srv, "ren").await;
    let thread = thread_by(&srv, &ann, &s, "Pizza").await;

    assert_eq!(
        rename(&srv, &ann, &thread, "Pizza night").await,
        200,
        "the starter"
    );
    assert_eq!(
        listed(&srv, &bo, &s, &thread).await.unwrap()["name"],
        "Pizza night"
    );
    assert_eq!(
        rename(&srv, &bo, &thread, "Bo's now").await,
        403,
        "another member"
    );
    assert_eq!(
        rename(&srv, &owner, &thread, "Pizza (Sat)").await,
        200,
        "the owner manages it"
    );
    assert_eq!(
        rename(&srv, &ann, &thread, "   ").await,
        400,
        "a name can't be blank"
    );
    assert_eq!(
        rename(&srv, &ann, &thread, &"x".repeat(101)).await,
        400,
        "a name stays within 100 characters"
    );
    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["name"],
        "Pizza (Sat)"
    );
    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["owner_id"],
        ann.id.as_str()
    );

    // Only threads: an ordinary channel isn't renamed through here.
    assert_eq!(rename(&srv, &owner, &s.general, "nope").await, 404);
}

#[tokio::test]
async fn deleting_a_thread_takes_its_messages_and_files_and_everyone_watching_hears() {
    let srv = TestServer::start().await;
    let (owner, ann, bo, s) = three(&srv, "del").await;
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let thread = thread_by(&srv, &ann, &s, "Photos").await;

    // A reply with a file in it.
    let (content_type, body) =
        multipart_file("file", "pic.png", "image/png", b"\x89PNG thread picture");
    let up = srv
        .post_raw_auth("/api/v1/upload", &ann.token, &content_type, body)
        .await;
    assert_eq!(up.status(), 200, "upload");
    let file_id = up.json::<Value>().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{thread}/messages"),
            &ann.token,
            json!({ "content": "look", "attachment_ids": [file_id] }),
        )
        .await;
    assert_eq!(res.status(), 200);

    let mut gw = Gateway::connect(&srv, &owner.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    let path = format!("/api/v1/threads/{thread}");
    assert_eq!(
        srv.delete_auth(&path, &bo.token).await.status(),
        403,
        "another member"
    );
    assert_eq!(
        srv.delete_auth(&path, &ann.token).await.status(),
        204,
        "the starter"
    );

    let gone = tokio::time::timeout(
        Duration::from_secs(5),
        gw.wait_for(|e| e["t"] == "ThreadDelete"),
    )
    .await
    .expect("people watching the channel hear the thread went");
    assert_eq!(gone["d"]["id"], thread.as_str());
    assert_eq!(gone["d"]["parent_id"], s.general.as_str());

    let left: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM channels WHERE id = ?1),
                (SELECT COUNT(*) FROM messages WHERE channel_id = ?1),
                (SELECT COUNT(*) FROM files WHERE id = ?2)",
    )
    .bind(&thread)
    .bind(&file_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        left,
        (0, 0, 0),
        "the thread, its messages and its file are gone"
    );
    assert!(listed(&srv, &owner, &s, &thread).await.is_none());
    assert_eq!(
        srv.delete_auth(&path, &ann.token).await.status(),
        404,
        "already gone"
    );
}

#[tokio::test]
async fn a_manager_can_delete_a_thread_someone_else_started() {
    let srv = TestServer::start().await;
    let (owner, ann, _bo, s) = three(&srv, "mdel").await;
    let thread = thread_by(&srv, &ann, &s, "Off topic").await;
    let res = srv
        .delete_auth(&format!("/api/v1/threads/{thread}"), &owner.token)
        .await;
    assert_eq!(res.status(), 204);
    assert!(listed(&srv, &owner, &s, &thread).await.is_none());
}

#[tokio::test]
async fn starting_or_replying_follows_a_thread_and_it_can_be_unfollowed() {
    let srv = TestServer::start().await;
    let (_owner, ann, bo, s) = three(&srv, "fol").await;
    let thread = thread_by(&srv, &ann, &s, "Plans").await;

    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["following"],
        true,
        "starting follows"
    );
    assert_eq!(
        listed(&srv, &bo, &s, &thread).await.unwrap()["following"],
        false
    );

    say(&srv, &bo, &thread, "count me in").await;
    assert_eq!(
        listed(&srv, &bo, &s, &thread).await.unwrap()["following"],
        true,
        "replying follows"
    );

    assert_eq!(follow(&srv, &bo, &thread, false).await, 204);
    assert_eq!(
        listed(&srv, &bo, &s, &thread).await.unwrap()["following"],
        false
    );
    assert_eq!(follow(&srv, &bo, &thread, true).await, 204);
    assert_eq!(
        listed(&srv, &bo, &s, &thread).await.unwrap()["following"],
        true
    );

    // Only threads, and only ones you can see.
    assert_eq!(follow(&srv, &bo, &s.general, true).await, 404);
    let stranger = srv.register("tf_fol_stranger", PASS).await;
    assert_eq!(follow(&srv, &stranger, &thread, true).await, 404);
}

#[tokio::test]
async fn following_reaches_your_other_open_devices() {
    let srv = TestServer::start().await;
    let (_owner, ann, bo, s) = three(&srv, "dev").await;
    let thread = thread_by(&srv, &ann, &s, "Live").await;
    let mut other_device = Gateway::connect(&srv, &bo.token).await;
    other_device.wait_for(|e| e["t"] == "Ready").await;

    assert_eq!(follow(&srv, &bo, &thread, true).await, 204);
    let ev = tokio::time::timeout(
        Duration::from_secs(5),
        other_device.wait_for(|e| e["t"] == "ThreadFollowUpdate"),
    )
    .await
    .expect("the other device hears about the follow");
    assert_eq!(ev["d"]["following"], true);
    assert_eq!(ev["d"]["thread"]["id"], thread.as_str());
}

#[tokio::test]
async fn ready_counts_unread_in_threads_you_follow_and_not_in_the_rest() {
    let srv = TestServer::start().await;
    let (_owner, ann, bo, s) = three(&srv, "unr").await;
    let thread = thread_by(&srv, &ann, &s, "Movies").await;
    say(&srv, &bo, &thread, "I'm in").await; // Bo follows by replying
    say(&srv, &bo, &thread, "what time?").await;
    // Bo has read everything so far (their read cursor, as an Ack would leave it).
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES (?, ?, ?)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at",
    )
    .bind(&thread)
    .bind(&bo.id)
    .bind(common::now_unix() + 1)
    .execute(&db)
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(2100)).await; // later than the read cursor
    say(&srv, &ann, &thread, "7pm").await;
    say(&srv, &ann, &thread, "bring snacks").await;

    let carol = srv.register("tf_unr_carol", PASS).await;
    join(&srv, &ann, &s, &carol).await;

    let mut gw_bo = Gateway::connect(&srv, &bo.token).await;
    let ready = gw_bo.wait_for(|e| e["t"] == "Ready").await;
    assert_eq!(
        ready["d"]["unread"][&thread], 2,
        "Bo follows: two new replies"
    );
    let followed: Vec<&str> = ready["d"]["followed_threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(followed, [thread.as_str()]);

    let mut gw_carol = Gateway::connect(&srv, &carol.token).await;
    let ready = gw_carol.wait_for(|e| e["t"] == "Ready").await;
    assert!(
        ready["d"]["unread"].get(&thread).is_none(),
        "Carol doesn't follow it"
    );
    assert_eq!(ready["d"]["followed_threads"], json!([]));
}

#[tokio::test]
async fn a_reply_wakes_the_phones_of_followers_and_of_people_it_mentions_only() {
    let srv = TestServer::start().await;
    let (_owner, ann, bo, s) = three(&srv, "push").await;
    let carol = srv.register("tf_push_carol", PASS).await;
    join(&srv, &ann, &s, &carol).await;
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    for (who, n) in [(&bo, 1), (&carol, 2)] {
        let res = srv
            .put_json_auth(
                "/api/v1/push/devices",
                &who.token,
                json!({
                    "platform": "web",
                    "endpoint": format!("https://fcm.googleapis.com/fcm/send/thread-followups-{n}"),
                    "p256dh": "p256dh-key",
                    "auth": "auth-key",
                    "device_name": "Phone"
                }),
            )
            .await;
        assert_eq!(res.status(), 200);
    }
    let nudges = |user: String| {
        let db = db.clone();
        async move {
            let n: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE user_id = ?")
                    .bind(&user)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            sqlx::query("DELETE FROM push_deliveries")
                .execute(&db)
                .await
                .unwrap();
            n
        }
    };

    let thread = thread_by(&srv, &ann, &s, "Trip").await;
    say(&srv, &bo, &thread, "following now").await; // Bo follows
    nudges(bo.id.clone()).await;

    say(&srv, &ann, &thread, "leaving at 9").await;
    assert_eq!(nudges(bo.id.clone()).await, 1, "a follower is woken");
    say(&srv, &ann, &thread, "leaving at 10").await;
    assert_eq!(
        nudges(carol.id.clone()).await,
        0,
        "someone who doesn't follow isn't"
    );
    say(&srv, &ann, &thread, "@tf_push_carol you coming?").await;
    assert_eq!(nudges(carol.id.clone()).await, 1, "unless it mentions them");

    // A muted parent channel mutes its threads for followers.
    let res = srv
        .put_json_auth(
            &format!(
                "/api/v1/users/@me/notification-settings/channel/{}",
                s.general
            ),
            &bo.token,
            json!({ "muted": true }),
        )
        .await;
    assert!(res.status().is_success());
    say(&srv, &ann, &thread, "anyone?").await;
    assert_eq!(nudges(bo.id.clone()).await, 0, "muted with its channel");
}

#[tokio::test]
async fn a_thread_nobody_wrote_in_for_a_week_is_archived_until_someone_does() {
    let srv = TestServer::start().await;
    let (_owner, ann, _bo, s) = three(&srv, "arc").await;
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let thread = thread_by(&srv, &ann, &s, "Old news").await;
    say(&srv, &ann, &thread, "first").await;
    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["archived"],
        false
    );

    // Eight days pass.
    sqlx::query("UPDATE messages SET created_at = created_at - ?1 WHERE channel_id = ?2")
        .bind(WEEK + 24 * 60 * 60)
        .bind(&thread)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE channels SET created_at = created_at - ?1 WHERE id = ?2")
        .bind(WEEK + 24 * 60 * 60)
        .bind(&thread)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["archived"],
        true
    );

    say(&srv, &ann, &thread, "back again").await;
    assert_eq!(
        listed(&srv, &ann, &s, &thread).await.unwrap()["archived"],
        false
    );
}
