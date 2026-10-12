//! Notification settings, like Discord's: a space can notify for every message, only for
//! @mentions, or not at all, and a space, a channel or a DM can be muted for a while or until
//! it's turned back on. They're stored per account, so every device follows them, and the
//! push relay obeys them: a muted chat sends no nudge to your phone, but an @mention still
//! gets through a mute unless the space is set to "Nothing".

mod common;

use common::{now_unix, ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const PASS: &str = "supersecret123";
const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/notification-settings-test";

/// `owner` makes a space and `member` joins it. Returns (space id, #general id).
async fn space_with_member(srv: &TestServer, owner: &AuthOk, member: &AuthOk) -> (String, String) {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Bells" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let general_id = server["channels"][0]["id"].as_str().unwrap().to_owned();
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
    (server_id, general_id)
}

async fn set(
    srv: &TestServer,
    token: &str,
    target_type: &str,
    target_id: &str,
    body: Value,
) -> reqwest::Response {
    srv.put_json_auth(
        &format!("/api/v1/users/@me/notification-settings/{target_type}/{target_id}"),
        token,
        body,
    )
    .await
}

async fn list(srv: &TestServer, token: &str) -> Vec<Value> {
    let res = srv
        .get_auth("/api/v1/users/@me/notification-settings", token)
        .await;
    assert_eq!(res.status(), 200, "the settings list answers");
    res.json::<Vec<Value>>().await.unwrap()
}

async fn open_dm(srv: &TestServer, token: &str, recipient: &str) -> String {
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            token,
            json!({ "recipient_id": recipient }),
        )
        .await
        .json()
        .await
        .unwrap();
    dm["id"].as_str().unwrap().to_owned()
}

async fn register_device(srv: &TestServer, token: &str) {
    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            token,
            json!({
                "platform": "web",
                "endpoint": ENDPOINT,
                "p256dh": "p256dh-key",
                "auth": "auth-key",
                "device_name": "Phone"
            }),
        )
        .await;
    assert_eq!(res.status(), 200);
}

async fn send(srv: &TestServer, token: &str, channel_id: &str, content: &str) {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            token,
            json!({ "content": content }),
        )
        .await;
    assert_eq!(res.status(), 200, "message sent");
}

/// Wake-up nudges queued for `user_id`, then cleared, so the next message is judged on its
/// own (a device with a nudge already waiting gets no second one).
async fn take_nudges(srv: &TestServer, user_id: &str) -> i64 {
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM push_deliveries")
        .execute(&db)
        .await
        .unwrap();
    n
}

fn find<'a>(settings: &'a [Value], target_type: &str, target_id: &str) -> Option<&'a Value> {
    settings
        .iter()
        .find(|s| s["target_type"] == target_type && s["target_id"] == target_id)
}

#[tokio::test]
async fn a_member_sets_a_space_level_and_mutes_a_channel_and_reads_them_back() {
    let srv = TestServer::start().await;
    let owner = srv.register("bellowner", PASS).await;
    let member = srv.register("bellmember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;

    let res = set(
        &srv,
        &member.token,
        "server",
        &server_id,
        json!({ "level": "mentions", "muted": false }),
    )
    .await;
    assert_eq!(res.status(), 200, "a member sets their space's level");
    let saved: Value = res.json().await.unwrap();
    assert_eq!(saved["level"], "mentions");
    assert_eq!(saved["muted"], false);

    let before = now_unix();
    let res = set(
        &srv,
        &member.token,
        "channel",
        &general_id,
        json!({ "muted": true, "mute_seconds": 3600 }),
    )
    .await;
    assert_eq!(res.status(), 200, "a member mutes a channel for an hour");
    let saved: Value = res.json().await.unwrap();
    assert_eq!(saved["muted"], true);
    let until = saved["muted_until"]
        .as_i64()
        .expect("an hour's mute has an end");
    assert!(
        until >= before + 3600 && until <= now_unix() + 3600,
        "the mute ends an hour from now by the server's clock, got {until}"
    );

    let settings = list(&srv, &member.token).await;
    assert_eq!(
        find(&settings, "server", &server_id).unwrap()["level"],
        "mentions"
    );
    assert_eq!(
        find(&settings, "channel", &general_id).unwrap()["muted"],
        true
    );
    assert!(
        list(&srv, &owner.token).await.is_empty(),
        "settings are per account"
    );

    // "Until I turn it back on" has no end.
    let res = set(
        &srv,
        &member.token,
        "server",
        &server_id,
        json!({ "level": "mentions", "muted": true }),
    )
    .await;
    assert_eq!(res.status(), 200);
    let saved: Value = res.json().await.unwrap();
    assert_eq!(saved["muted"], true);
    assert!(saved["muted_until"].is_null(), "muted until turned back on");
}

#[tokio::test]
async fn ready_carries_your_notification_settings() {
    let srv = TestServer::start().await;
    let owner = srv.register("readybellowner", PASS).await;
    let member = srv.register("readybellmember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    assert_eq!(
        set(
            &srv,
            &member.token,
            "server",
            &server_id,
            json!({ "level": "nothing", "muted": false })
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        set(
            &srv,
            &member.token,
            "channel",
            &general_id,
            json!({ "muted": true })
        )
        .await
        .status(),
        200
    );

    let mut gw = Gateway::connect(&srv, &member.token).await;
    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;
    let settings = ready["d"]["notification_settings"]
        .as_array()
        .expect("Ready lists the notification settings")
        .clone();
    assert_eq!(
        find(&settings, "server", &server_id).unwrap()["level"],
        "nothing"
    );
    assert_eq!(
        find(&settings, "channel", &general_id).unwrap()["muted"],
        true
    );
}

#[tokio::test]
async fn a_change_reaches_your_other_open_devices() {
    let srv = TestServer::start().await;
    let owner = srv.register("livebellowner", PASS).await;
    let member = srv.register("livebellmember", PASS).await;
    let (_server_id, general_id) = space_with_member(&srv, &owner, &member).await;

    let mut other_device = Gateway::connect(&srv, &member.token).await;
    other_device.wait_for(|ev| ev["t"] == "Ready").await;
    assert_eq!(
        set(
            &srv,
            &member.token,
            "channel",
            &general_id,
            json!({ "muted": true, "mute_seconds": 900 })
        )
        .await
        .status(),
        200
    );
    let update = other_device
        .wait_for(|ev| ev["t"] == "NotificationSettingsUpdate")
        .await;
    assert_eq!(update["d"]["target_type"], "channel");
    assert_eq!(update["d"]["target_id"], general_id);
    assert_eq!(update["d"]["muted"], true);
}

#[tokio::test]
async fn settings_for_chats_you_are_not_in_or_nonsense_values_are_refused() {
    let srv = TestServer::start().await;
    let owner = srv.register("refuseowner", PASS).await;
    let member = srv.register("refusemember", PASS).await;
    let stranger = srv.register("refusestranger", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    let dm = open_dm(&srv, &owner.token, &member.id).await;

    for (target_type, target_id) in [
        ("server", server_id.as_str()),
        ("channel", general_id.as_str()),
        ("channel", dm.as_str()),
        ("server", "no-such-space"),
    ] {
        let status = set(
            &srv,
            &stranger.token,
            target_type,
            target_id,
            json!({ "muted": true }),
        )
        .await
        .status();
        assert_eq!(
            status, 404,
            "a stranger can't set {target_type} {target_id}"
        );
    }
    for body in [
        json!({ "level": "loud", "muted": false }),
        json!({ "muted": true, "mute_seconds": 5 }),
        json!({ "muted": true, "mute_seconds": 40_000_000 }),
    ] {
        let status = set(&srv, &member.token, "server", &server_id, body.clone())
            .await
            .status();
        assert_eq!(status, 400, "{body} is refused");
    }
    let status = set(
        &srv,
        &member.token,
        "channel",
        &general_id,
        json!({ "level": "mentions", "muted": false }),
    )
    .await
    .status();
    assert_eq!(status, 400, "a level is set per space, not per channel");
    let status = set(
        &srv,
        &member.token,
        "planet",
        &server_id,
        json!({ "muted": true }),
    )
    .await
    .status();
    assert_eq!(status, 400, "only spaces and channels have settings");
    assert!(
        list(&srv, &stranger.token).await.is_empty(),
        "nothing was stored for the stranger"
    );
}

#[tokio::test]
async fn back_to_the_defaults_leaves_nothing_stored() {
    let srv = TestServer::start().await;
    let owner = srv.register("resetowner", PASS).await;
    let member = srv.register("resetmember", PASS).await;
    let (server_id, _general_id) = space_with_member(&srv, &owner, &member).await;
    assert_eq!(
        set(
            &srv,
            &member.token,
            "server",
            &server_id,
            json!({ "level": "mentions", "muted": true })
        )
        .await
        .status(),
        200
    );
    let res = set(
        &srv,
        &member.token,
        "server",
        &server_id,
        json!({ "level": "all", "muted": false }),
    )
    .await;
    assert_eq!(res.status(), 200);
    let saved: Value = res.json().await.unwrap();
    assert_eq!(saved["muted"], false);
    assert!(
        list(&srv, &member.token).await.is_empty(),
        "the defaults aren't stored"
    );
}

#[tokio::test]
async fn a_muted_dm_sends_no_push_until_it_is_unmuted() {
    let srv = TestServer::start().await;
    let alice = srv.register("dmpushalice", PASS).await;
    let bob = srv.register("dmpushbob", PASS).await;
    register_device(&srv, &bob.token).await;
    let dm = open_dm(&srv, &alice.token, &bob.id).await;

    send(&srv, &alice.token, &dm, "before muting").await;
    assert_eq!(
        take_nudges(&srv, &bob.id).await,
        1,
        "an unmuted DM nudges the phone"
    );

    assert_eq!(
        set(&srv, &bob.token, "channel", &dm, json!({ "muted": true }))
            .await
            .status(),
        200
    );
    send(&srv, &alice.token, &dm, "while muted, even @dmpushbob").await;
    assert_eq!(
        take_nudges(&srv, &bob.id).await,
        0,
        "a muted DM sends no push at all"
    );

    assert_eq!(
        set(&srv, &bob.token, "channel", &dm, json!({ "muted": false }))
            .await
            .status(),
        200
    );
    send(&srv, &alice.token, &dm, "after unmuting").await;
    assert_eq!(
        take_nudges(&srv, &bob.id).await,
        1,
        "unmuted, it nudges again"
    );
}

#[tokio::test]
async fn a_muted_channel_still_pushes_when_you_are_mentioned() {
    let srv = TestServer::start().await;
    let owner = srv.register("mentionowner", PASS).await;
    let member = srv.register("mentionmember", PASS).await;
    let (_server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    register_device(&srv, &member.token).await;
    assert_eq!(
        set(
            &srv,
            &member.token,
            "channel",
            &general_id,
            json!({ "muted": true })
        )
        .await
        .status(),
        200
    );

    send(&srv, &owner.token, &general_id, "just chatting").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        0,
        "a muted channel stays quiet"
    );
    send(&srv, &owner.token, &general_id, "hey @MentionMember look").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        1,
        "an @mention gets through the mute"
    );
    send(
        &srv,
        &owner.token,
        &general_id,
        "email mentionmember@example.com is not a mention",
    )
    .await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        0,
        "only a whole @name counts"
    );
}

#[tokio::test]
async fn only_mentions_pushes_only_mentions_and_nothing_pushes_nothing() {
    let srv = TestServer::start().await;
    let owner = srv.register("levelowner", PASS).await;
    let member = srv.register("levelmember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    register_device(&srv, &member.token).await;

    send(
        &srv,
        &owner.token,
        &general_id,
        "everyone hears this by default",
    )
    .await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        1,
        "by default every message nudges"
    );

    assert_eq!(
        set(
            &srv,
            &member.token,
            "server",
            &server_id,
            json!({ "level": "mentions", "muted": false })
        )
        .await
        .status(),
        200
    );
    send(&srv, &owner.token, &general_id, "no mention here").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        0,
        "only @mentions: a plain message is quiet"
    );
    send(&srv, &owner.token, &general_id, "@levelmember you there?").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        1,
        "only @mentions: a mention nudges"
    );
    send(&srv, &owner.token, &general_id, "@everyone meeting now").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        1,
        "@everyone counts as a mention"
    );

    assert_eq!(
        set(
            &srv,
            &member.token,
            "server",
            &server_id,
            json!({ "level": "nothing", "muted": false })
        )
        .await
        .status(),
        200
    );
    send(&srv, &owner.token, &general_id, "@levelmember still there?").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        0,
        "Nothing means nothing, mentions too"
    );
}

#[tokio::test]
async fn a_mute_that_has_run_out_no_longer_silences() {
    let srv = TestServer::start().await;
    let owner = srv.register("expireowner", PASS).await;
    let member = srv.register("expiremember", PASS).await;
    let (_server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    register_device(&srv, &member.token).await;
    assert_eq!(
        set(
            &srv,
            &member.token,
            "channel",
            &general_id,
            json!({ "muted": true, "mute_seconds": 900 })
        )
        .await
        .status(),
        200
    );

    // Fifteen minutes pass.
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query("UPDATE notification_settings SET muted_until = ?")
        .bind(now_unix() - 1)
        .execute(&db)
        .await
        .unwrap();

    send(&srv, &owner.token, &general_id, "the mute is over").await;
    assert_eq!(
        take_nudges(&srv, &member.id).await,
        1,
        "an ended mute no longer silences"
    );
    let settings = list(&srv, &member.token).await;
    assert!(
        find(&settings, "channel", &general_id).is_none_or(|s| s["muted"] == false),
        "an ended mute isn't reported as muted"
    );
}

#[tokio::test]
async fn writes_are_rate_limited() {
    let srv = TestServer::start().await;
    let owner = srv.register("rateowner", PASS).await;
    let member = srv.register("ratemember", PASS).await;
    let (server_id, _general_id) = space_with_member(&srv, &owner, &member).await;
    let mut last = 0;
    for i in 0..70 {
        let muted = i % 2 == 0;
        last = set(
            &srv,
            &member.token,
            "server",
            &server_id,
            json!({ "muted": muted }),
        )
        .await
        .status()
        .as_u16();
        if last == 429 {
            break;
        }
    }
    assert_eq!(last, 429, "a flood of setting changes is slowed down");
}

/// Settings rows that name `target_id`, for anyone, straight from the database.
async fn rows_for(srv: &TestServer, target_id: &str) -> i64 {
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let (n,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM notification_settings WHERE target_id = ?")
            .bind(target_id)
            .fetch_one(&db)
            .await
            .unwrap();
    db.close().await;
    n
}

#[tokio::test]
async fn deleting_a_channel_takes_its_settings_and_its_threads_settings() {
    let srv = TestServer::start().await;
    let owner = srv.register("goneowner", PASS).await;
    let member = srv.register("gonemember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    let channel: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &owner.token,
            json!({ "name": "random" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let channel_id = channel["id"].as_str().unwrap().to_owned();
    let first: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &owner.token,
            json!({ "content": "start here" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let thread: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/threads"),
            &owner.token,
            json!({ "message_id": first["id"], "name": "Side talk" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_owned();

    for channel in [&channel_id, &general_id] {
        let res = set(
            &srv,
            &member.token,
            "channel",
            channel,
            json!({ "muted": true }),
        )
        .await;
        assert_eq!(res.status(), 200);
    }
    // A thread's own row, as a later version of the app might store one.
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO notification_settings (user_id, target_type, target_id, level, muted, muted_until, updated_at)
         VALUES (?, 'channel', ?, NULL, 1, NULL, ?)",
    )
    .bind(&member.id)
    .bind(&thread_id)
    .bind(now_unix())
    .execute(&db)
    .await
    .unwrap();
    db.close().await;
    assert_eq!(rows_for(&srv, &channel_id).await, 1);
    assert_eq!(rows_for(&srv, &thread_id).await, 1);

    let res = srv
        .delete_auth(&format!("/api/v1/channels/{channel_id}"), &owner.token)
        .await;
    assert_eq!(res.status(), 204);
    assert_eq!(
        rows_for(&srv, &channel_id).await,
        0,
        "the channel's settings go with it"
    );
    assert_eq!(
        rows_for(&srv, &thread_id).await,
        0,
        "and so do its threads' settings"
    );
    assert_eq!(
        rows_for(&srv, &general_id).await,
        1,
        "another channel's settings stay"
    );
}

#[tokio::test]
async fn deleting_a_space_takes_every_setting_inside_it() {
    let srv = TestServer::start().await;
    let owner = srv.register("spacegoneowner", PASS).await;
    let member = srv.register("spacegonemember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    let res = set(
        &srv,
        &member.token,
        "server",
        &server_id,
        json!({ "level": "mentions", "muted": false }),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = set(
        &srv,
        &member.token,
        "channel",
        &general_id,
        json!({ "muted": true }),
    )
    .await;
    assert_eq!(res.status(), 200);

    let res = srv
        .delete_json_auth(
            &format!("/api/v1/servers/{server_id}"),
            &owner.token,
            json!({ "password": PASS }),
        )
        .await;
    assert_eq!(res.status(), 204);
    assert_eq!(
        rows_for(&srv, &server_id).await,
        0,
        "the space's own settings go"
    );
    assert_eq!(
        rows_for(&srv, &general_id).await,
        0,
        "and its channels' settings"
    );
}

#[tokio::test]
async fn a_space_deleted_with_its_owners_account_leaves_no_settings_behind() {
    let srv = TestServer::start().await;
    let owner = srv.register("lonelyowner", PASS).await;
    let member = srv.register("formermember", PASS).await;
    let (server_id, general_id) = space_with_member(&srv, &owner, &member).await;
    let res = set(
        &srv,
        &member.token,
        "server",
        &server_id,
        json!({ "level": "nothing", "muted": false }),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = set(
        &srv,
        &member.token,
        "channel",
        &general_id,
        json!({ "muted": true }),
    )
    .await;
    assert_eq!(res.status(), 200);
    // The member leaves (their settings stay theirs), so the owner is alone in the space, and
    // deleting the owner's account deletes the space.
    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/leave"),
            &member.token,
            json!({}),
        )
        .await;
    assert!(res.status().is_success(), "leave: {}", res.status());
    let res = srv
        .delete_json_auth(
            "/api/v1/users/@me",
            &owner.token,
            json!({ "password": PASS, "username": "lonelyowner" }),
        )
        .await;
    assert_eq!(res.status(), 204);
    assert_eq!(
        rows_for(&srv, &server_id).await,
        0,
        "the deleted space's settings go"
    );
    assert_eq!(
        rows_for(&srv, &general_id).await,
        0,
        "and its channels' settings"
    );
}
