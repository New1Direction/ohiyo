//! Incoming webhooks: a secret URL that another service posts to, and the message appears in
//! a space's text channel under the webhook's name, marked as an app. Only people who can
//! manage the space's channels make, rename, renew or delete them; the URL's token is shown
//! once and only a hash of it is kept. Posting needs no account, so it is rate-limited, size-
//! limited, says nothing about which part of a wrong URL was wrong, and can't ping everyone.

mod common;

use std::sync::Once;
use std::time::Duration;

use common::{multipart_file, ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

static BASE_URL: Once = Once::new();

/// The avatar endpoint builds a full URL from PUBLIC_BASE_URL, which main() guarantees.
async fn start() -> TestServer {
    BASE_URL.call_once(|| std::env::set_var("PUBLIC_BASE_URL", "http://localhost:3000"));
    TestServer::start().await
}

struct Space {
    id: String,
    general: String,
    voice: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let body: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let channel = |kind: &str| {
        body["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["channel_type"] == kind)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    Space {
        id: body["id"].as_str().unwrap().to_owned(),
        general: channel("text"),
        voice: channel("voice"),
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

async fn create(srv: &TestServer, who: &AuthOk, channel: &str, name: &str) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel}/webhooks"),
        &who.token,
        json!({ "name": name }),
    )
    .await
}

/// A webhook made by `who` in `channel`: (id, token).
async fn made(srv: &TestServer, who: &AuthOk, channel: &str, name: &str) -> (String, String) {
    let res = create(srv, who, channel, name).await;
    assert_eq!(res.status(), 200, "create webhook");
    let body: Value = res.json().await.unwrap();
    (
        body["id"].as_str().unwrap().to_owned(),
        body["token"].as_str().unwrap().to_owned(),
    )
}

/// Post to a webhook's URL with no account, as another service would.
async fn execute(srv: &TestServer, id: &str, token: &str, body: Value) -> reqwest::Response {
    srv.client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}")))
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn latest(srv: &TestServer, who: &AuthOk, channel: &str) -> Value {
    let res = srv
        .get_auth(
            &format!("/api/v1/channels/{channel}/messages?limit=5"),
            &who.token,
        )
        .await;
    assert_eq!(res.status(), 200, "list messages");
    let body: Value = res.json().await.unwrap();
    let list = body
        .as_array()
        .cloned()
        .or_else(|| body["messages"].as_array().cloned())
        .unwrap_or_default();
    list.into_iter()
        .max_by_key(|m| m["created_at"].as_i64().unwrap_or(0))
        .expect("a message")
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[tokio::test]
async fn only_people_who_manage_channels_can_make_webhooks() {
    let srv = start().await;
    let owner = srv.register("hookowner", "password123").await;
    let member = srv.register("hookmember", "password123").await;
    let outsider = srv.register("hookoutsider", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &member).await;

    assert_eq!(
        create(&srv, &owner, &sp.general, "Deploys").await.status(),
        200
    );
    assert_eq!(
        create(&srv, &member, &sp.general, "Mine").await.status(),
        403
    );
    let res = create(&srv, &outsider, &sp.general, "Theirs").await;
    assert!(
        res.status() == 403 || res.status() == 404,
        "an outsider gets {}",
        res.status()
    );
    let list = srv
        .get_auth(
            &format!("/api/v1/channels/{}/webhooks", sp.general),
            &member.token,
        )
        .await;
    assert_eq!(list.status(), 403, "a member can't list them either");
}

#[tokio::test]
async fn only_text_channels_in_spaces_take_webhooks() {
    let srv = start().await;
    let owner = srv.register("hookchan", "password123").await;
    let friend = srv.register("hookchanfriend", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;

    assert_eq!(create(&srv, &owner, &sp.voice, "Voice").await.status(), 400);
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
    let res = create(&srv, &owner, dm["id"].as_str().unwrap(), "Secret").await;
    assert_eq!(
        res.status(),
        400,
        "DMs are end-to-end encrypted and take no webhooks"
    );
    assert_eq!(
        create(&srv, &owner, &sp.general, "").await.status(),
        400,
        "a name is needed"
    );
    let long = "x".repeat(65);
    assert_eq!(
        create(&srv, &owner, &sp.general, &long).await.status(),
        400,
        "names keep to 64 characters, like display names"
    );
    let fits = "x".repeat(64);
    assert_eq!(create(&srv, &owner, &sp.general, &fits).await.status(), 200);
}

#[tokio::test]
async fn the_token_is_shown_once_and_only_its_hash_is_kept() {
    let srv = start().await;
    let owner = srv.register("hooktoken", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;

    let res = create(&srv, &owner, &sp.general, "Deploys").await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let id = body["id"].as_str().unwrap();
    let token = body["token"].as_str().unwrap();
    assert!(token.len() >= 43, "at least 256 bits: {}", token.len());
    assert!(
        body["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/api/v1/webhooks/{id}/{token}")),
        "the URL to post to: {}",
        body["url"]
    );

    let list: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{}/webhooks", sp.general),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let listed = list.as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "Deploys");
    assert!(
        !list.to_string().contains(token),
        "the list never shows the token again"
    );

    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM webhooks WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(stored, token);
    assert_eq!(stored, sha256_hex(token));
}

#[tokio::test]
async fn posting_to_the_url_puts_a_message_in_the_channel_from_the_webhook() {
    let srv = start().await;
    let owner = srv.register("hookpost", "password123").await;
    let member = srv.register("hookpostmember", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &member).await;
    let (id, token) = made(&srv, &owner, &sp.general, "Deploy bot").await;

    let mut gw = Gateway::connect(&srv, &member.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    let res = execute(
        &srv,
        &id,
        &token,
        json!({ "content": "Deploy finished ✅" }),
    )
    .await;
    assert_eq!(res.status(), 204, "no body unless ?wait=true");

    let live = tokio::time::timeout(
        Duration::from_secs(5),
        gw.wait_for(|e| e["t"] == "MessageCreate"),
    )
    .await
    .expect("members see it live");
    assert_eq!(live["d"]["content"], "Deploy finished ✅");
    assert_eq!(live["d"]["author"]["display_name"], "Deploy bot");
    assert_eq!(live["d"]["author"]["bot"], true);

    let msg = latest(&srv, &member, &sp.general).await;
    assert_eq!(msg["content"], "Deploy finished ✅");
    assert_eq!(msg["author"]["display_name"], "Deploy bot");
    assert_eq!(msg["author"]["bot"], true);

    // ?wait=true answers with the message; Slack-style {"text": …} works too.
    let res = srv
        .client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}?wait=true")))
        .json(&json!({ "text": "from a Slack-style poster" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["content"], "from a Slack-style poster");
    assert_eq!(body["channel_id"], sp.general);

    // A person's own messages are not marked as an app.
    let mine: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/messages", sp.general),
            &owner.token,
            json!({ "content": "thanks bot" }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(mine["author"]["bot"].is_null() || mine["author"]["bot"] == false);
}

#[tokio::test]
async fn a_post_cannot_pose_as_someone_else() {
    let srv = start().await;
    let owner = srv.register("hookpose", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;

    let res = execute(
        &srv,
        &id,
        &token,
        json!({ "content": "trust me", "username": "hookpose", "avatar_url": "https://evil.example/a.png" }),
    )
    .await;
    assert_eq!(res.status(), 204);
    let msg = latest(&srv, &owner, &sp.general).await;
    assert_eq!(msg["author"]["display_name"], "CI");
    assert_ne!(msg["author"]["id"], owner.id);
    assert!(msg["author"]["avatar_url"].is_null());
}

#[tokio::test]
async fn a_wrong_url_is_not_found_whichever_part_is_wrong() {
    let srv = start().await;
    let owner = srv.register("hookwrong", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;

    let wrong_token = execute(&srv, &id, &format!("{token}x"), json!({ "content": "hi" })).await;
    let wrong_id = execute(&srv, "not-a-webhook", &token, json!({ "content": "hi" })).await;
    assert_eq!(wrong_token.status(), 404);
    assert_eq!(wrong_id.status(), 404);
    assert_eq!(
        wrong_token.text().await.unwrap(),
        wrong_id.text().await.unwrap(),
        "the same answer either way"
    );
}

#[tokio::test]
async fn a_post_needs_words_and_a_small_body() {
    let srv = start().await;
    let owner = srv.register("hookbody", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;

    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "   " }))
            .await
            .status(),
        400
    );
    assert_eq!(execute(&srv, &id, &token, json!({})).await.status(), 400);
    let too_long = "a".repeat(4001);
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": too_long }))
            .await
            .status(),
        400
    );
    let huge = json!({ "content": "hi", "padding": "p".repeat(64 * 1024) });
    assert_eq!(execute(&srv, &id, &token, huge).await.status(), 413);
    let res = srv
        .client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}")))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn a_webhook_cannot_ping_everyone() {
    let srv = start().await;
    let owner = srv.register("hookping", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;

    let res = execute(
        &srv,
        &id,
        &token,
        json!({ "content": "@everyone @here build broke" }),
    )
    .await;
    assert_eq!(res.status(), 204);
    let msg = latest(&srv, &owner, &sp.general).await;
    let content = msg["content"].as_str().unwrap();
    assert!(
        content.contains("everyone") && content.contains("here"),
        "the words stay: {content}"
    );
    assert!(
        !server::api::notifications::mentions(content, "nobody-in-particular"),
        "but they don't mention everyone: {content:?}"
    );
}

#[tokio::test]
async fn posting_too_fast_is_slowed_down() {
    let srv = start().await;
    let owner = srv.register("hookrate", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "Chatty").await;

    let mut statuses = Vec::new();
    for n in 0..8 {
        let res = execute(&srv, &id, &token, json!({ "content": format!("ping {n}") })).await;
        statuses.push(res.status().as_u16());
    }
    assert!(
        statuses[..5].iter().all(|s| *s == 204),
        "a burst of five goes through: {statuses:?}"
    );
    assert!(
        statuses.contains(&429),
        "then it's slowed down: {statuses:?}"
    );
}

#[tokio::test]
async fn renewing_the_url_ends_the_old_one() {
    let srv = start().await;
    let owner = srv.register("hookrenew", "password123").await;
    let member = srv.register("hookrenewmember", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &member).await;
    let (id, old) = made(&srv, &owner, &sp.general, "CI").await;

    let res = srv
        .post_json_auth(
            &format!("/api/v1/webhooks/{id}/token"),
            &member.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 403, "a member can't renew it");
    let res = srv
        .post_json_auth(
            &format!("/api/v1/webhooks/{id}/token"),
            &owner.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let new = body["token"].as_str().unwrap();
    assert_ne!(new, old);
    assert_eq!(
        execute(&srv, &id, &old, json!({ "content": "old" }))
            .await
            .status(),
        404
    );
    assert_eq!(
        execute(&srv, &id, new, json!({ "content": "new" }))
            .await
            .status(),
        204
    );
}

#[tokio::test]
async fn renaming_and_a_picture_change_how_it_shows() {
    let srv = start().await;
    let owner = srv.register("hookrename", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;

    let (content_type, body) = multipart_file("file", "bot.png", "image/png", b"not-really-a-png");
    let up = srv
        .post_raw_auth("/api/v1/upload", &owner.token, &content_type, body)
        .await;
    assert_eq!(up.status(), 200, "upload");
    let files: Value = up.json().await.unwrap();
    let file_id = files[0]["id"].as_str().unwrap();

    let res = srv
        .patch_json_auth(
            &format!("/api/v1/webhooks/{id}"),
            &owner.token,
            json!({ "name": "Build status", "avatar_file_id": file_id }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let hook: Value = res.json().await.unwrap();
    assert_eq!(hook["name"], "Build status");
    assert!(hook["avatar_url"].as_str().unwrap().contains(file_id));

    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "green" }))
            .await
            .status(),
        204
    );
    let msg = latest(&srv, &owner, &sp.general).await;
    assert_eq!(msg["author"]["display_name"], "Build status");
    assert!(msg["author"]["avatar_url"]
        .as_str()
        .unwrap()
        .contains(file_id));
}

#[tokio::test]
async fn deleting_a_webhook_ends_its_url_and_keeps_its_messages() {
    let srv = start().await;
    let owner = srv.register("hookdelete", "password123").await;
    let member = srv.register("hookdeletemember", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &member).await;
    let (id, token) = made(&srv, &owner, &sp.general, "Release notes").await;
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "v1.2 is out" }))
            .await
            .status(),
        204
    );

    assert_eq!(
        srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &member.token)
            .await
            .status(),
        403,
        "a member can't delete it"
    );
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &owner.token)
            .await
            .status(),
        204
    );
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "again" }))
            .await
            .status(),
        404
    );
    let msg = latest(&srv, &member, &sp.general).await;
    assert_eq!(msg["content"], "v1.2 is out");
    assert_eq!(msg["author"]["display_name"], "Release notes");
    let list: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{}/webhooks", sp.general),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_webhook_is_not_an_account() {
    let srv = start().await;
    let owner = srv.register("hookaccount", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "Zebra Alerts").await;
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "hi" }))
            .await
            .status(),
        204
    );
    let msg = latest(&srv, &owner, &sp.general).await;
    let bot_id = msg["author"]["id"].as_str().unwrap();
    let bot_name = msg["author"]["username"].as_str().unwrap();

    let login = srv
        .post_json(
            "/api/v1/auth/login",
            json!({ "username": bot_name, "password": "!" }),
        )
        .await;
    assert_eq!(login.status(), 401, "nobody signs in as a webhook");
    let found: Value = srv
        .get_auth("/api/v1/users/search?q=Zebra", &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        found.as_array().unwrap().len(),
        0,
        "search doesn't list webhooks"
    );
    let dm = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &owner.token,
            json!({ "recipient_id": bot_id }),
        )
        .await;
    assert_eq!(dm.status(), 404, "you can't DM a webhook");
    let friend = srv
        .post_json_auth(
            &format!("/api/v1/users/{bot_id}/friend-request"),
            &owner.token,
            json!({}),
        )
        .await;
    assert_eq!(friend.status(), 404, "you can't befriend a webhook");
    let group = srv
        .post_json_auth(
            "/api/v1/users/@me/group-dms",
            &owner.token,
            json!({ "recipient_ids": [bot_id] }),
        )
        .await;
    assert!(
        group.status() == 400 || group.status() == 404,
        "or add one to a group: {}",
        group.status()
    );
}

#[tokio::test]
async fn a_moderator_can_delete_a_webhook_message() {
    let srv = start().await;
    let owner = srv.register("hookmod", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "Spammy").await;
    let res = srv
        .client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}?wait=true")))
        .json(&json!({ "content": "buy now" }))
        .send()
        .await
        .unwrap();
    let msg: Value = res.json().await.unwrap();
    let mid = msg["id"].as_str().unwrap();
    assert_eq!(
        srv.delete_auth(
            &format!("/api/v1/channels/{}/messages/{mid}", sp.general),
            &owner.token
        )
        .await
        .status(),
        204
    );
}

const MANAGE_CHANNELS: i64 = 1 << 0;
const VIEW_CHANNEL: i64 = 1 << 6;
const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/webhook-test";

/// `who` gets a role with Manage Channels in `space`.
async fn make_moderator(srv: &TestServer, owner: &AuthOk, space: &Space, who: &AuthOk) {
    let role: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/roles", space.id),
            &owner.token,
            json!({ "name": "Mods", "permissions": MANAGE_CHANNELS | VIEW_CHANNEL | (1 << 7) }),
        )
        .await
        .json()
        .await
        .unwrap();
    let role_id = role["id"].as_str().unwrap();
    let res = srv
        .put_json_auth(
            &format!(
                "/api/v1/servers/{}/members/{}/roles/{role_id}",
                space.id, who.id
            ),
            &owner.token,
            json!({}),
        )
        .await;
    assert!(res.status().is_success(), "assign role: {}", res.status());
}

/// Deny `who` the right to see `channel`.
async fn hide_from(srv: &TestServer, space: &Space, channel: &str, who: &AuthOk) {
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES (?, ?, 'channel', ?, 'member', ?, 0, ?, 'test', 1)",
    )
    .bind(format!("ow-{}", who.id))
    .bind(&space.id)
    .bind(channel)
    .bind(&who.id)
    .bind(VIEW_CHANNEL)
    .execute(&db)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_manager_who_cannot_see_a_channel_cannot_touch_its_webhooks() {
    let srv = start().await;
    let owner = srv.register("hookseeowner", "password123").await;
    let modr = srv.register("hookseemod", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &modr).await;
    make_moderator(&srv, &owner, &sp, &modr).await;
    // Manage Channels works where they can see the channel …
    assert_eq!(
        create(&srv, &modr, &sp.general, "Visible").await.status(),
        200
    );
    // … but not in one hidden from them.
    let (id, _token) = made(&srv, &owner, &sp.general, "Leadership").await;
    hide_from(&srv, &sp, &sp.general, &modr).await;

    assert_eq!(
        create(&srv, &modr, &sp.general, "Sneaky").await.status(),
        404
    );
    let list = srv
        .get_auth(
            &format!("/api/v1/channels/{}/webhooks", sp.general),
            &modr.token,
        )
        .await;
    assert_eq!(list.status(), 404);
    let renew = srv
        .post_json_auth(
            &format!("/api/v1/webhooks/{id}/token"),
            &modr.token,
            json!({}),
        )
        .await;
    assert_eq!(
        renew.status(),
        404,
        "no new URL for a channel they can't see"
    );
    let rename = srv
        .patch_json_auth(
            &format!("/api/v1/webhooks/{id}"),
            &modr.token,
            json!({ "name": "x" }),
        )
        .await;
    assert_eq!(rename.status(), 404);
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &modr.token)
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn a_chat_you_are_not_in_answers_like_one_that_does_not_exist() {
    let srv = start().await;
    let owner = srv.register("hooknotin", "password123").await;
    let friend = srv.register("hooknotinfriend", "password123").await;
    let outsider = srv.register("hooknotinout", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
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

    let in_dm = create(&srv, &outsider, dm_id, "Spy").await;
    let in_space = create(&srv, &outsider, &sp.general, "Spy").await;
    let nowhere = create(&srv, &outsider, "no-such-channel", "Spy").await;
    assert_eq!(in_dm.status(), 404);
    assert_eq!(in_space.status(), 404);
    assert_eq!(nowhere.status(), 404);
    let texts = [
        in_dm.text().await.unwrap(),
        in_space.text().await.unwrap(),
        nowhere.text().await.unwrap(),
    ];
    assert!(
        texts.iter().all(|t| t == &texts[0]),
        "one answer for all three: {texts:?}"
    );
}

#[tokio::test]
async fn deleting_a_webhook_that_never_posted_removes_its_account_and_picture() {
    let srv = start().await;
    let owner = srv.register("hookclean", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, _token) = made(&srv, &owner, &sp.general, "Quiet").await;
    let (content_type, body) = multipart_file("file", "bot.png", "image/png", b"quiet-bot-png");
    let up: Value = srv
        .post_raw_auth("/api/v1/upload", &owner.token, &content_type, body)
        .await
        .json()
        .await
        .unwrap();
    let file_id = up[0]["id"].as_str().unwrap().to_owned();
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/webhooks/{id}"),
            &owner.token,
            json!({ "avatar_file_id": file_id }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let bot_id: String = sqlx::query_scalar("SELECT bot_user_id FROM webhooks WHERE id = ?")
        .bind(&id)
        .fetch_one(&db)
        .await
        .unwrap();

    assert_eq!(
        srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &owner.token)
            .await
            .status(),
        204
    );
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?")
        .bind(&bot_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0, "nothing it posted, so its account goes too");
    let file: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE id = ?")
        .bind(&file_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(file, 0, "and its picture, which nothing else uses");
}

#[tokio::test]
async fn the_sweep_removes_webhook_accounts_with_nothing_left() {
    let srv = start().await;
    let owner = srv.register("hooksweep", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "Once").await;
    let res = srv
        .client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}?wait=true")))
        .json(&json!({ "content": "only message" }))
        .send()
        .await
        .unwrap();
    let msg: Value = res.json().await.unwrap();
    let bot_id = msg["author"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &owner.token)
            .await
            .status(),
        204
    );
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let count = |db: SqlitePool, bot: String| async move {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE id = ?")
            .bind(bot)
            .fetch_one(&db)
            .await
            .unwrap()
    };
    assert_eq!(
        count(db.clone(), bot_id.clone()).await,
        1,
        "its message keeps it for now"
    );
    let mid = msg["id"].as_str().unwrap();
    assert_eq!(
        srv.delete_auth(
            &format!("/api/v1/channels/{}/messages/{mid}", sp.general),
            &owner.token
        )
        .await
        .status(),
        204
    );
    server::api::webhooks::sweep_orphan_accounts(&srv.state).await;
    assert_eq!(
        count(db, bot_id).await,
        0,
        "with no webhook and no messages, the sweep removes it"
    );
}

#[tokio::test]
async fn a_space_can_have_at_most_fifty_webhooks() {
    let srv = start().await;
    let owner = srv.register("hookcap", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    for n in 0..50 {
        sqlx::query(
            "INSERT INTO webhooks (id, channel_id, server_id, bot_user_id, name, token_hash, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'x', ?, 1)",
        )
        .bind(format!("seeded-{n}"))
        .bind(&sp.general)
        .bind(&sp.id)
        .bind(&owner.id)
        .bind(format!("Seeded {n}"))
        .bind(&owner.id)
        .execute(&db)
        .await
        .unwrap();
    }
    let res = create(&srv, &owner, &sp.general, "One too many").await;
    assert_eq!(res.status(), 400);
    assert!(
        res.text().await.unwrap().contains("50"),
        "says the space's limit"
    );
}

#[tokio::test]
async fn a_webhook_picture_outlives_the_manager_who_set_it() {
    let srv = start().await;
    let owner = srv.register("hookpicowner", "password123").await;
    let modr = srv.register("hookpicmod", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &modr).await;
    make_moderator(&srv, &owner, &sp, &modr).await;
    let (id, token) = made(&srv, &modr, &sp.general, "Status").await;
    let (content_type, body) = multipart_file("file", "bot.png", "image/png", b"mod-bot-png");
    let up: Value = srv
        .post_raw_auth("/api/v1/upload", &modr.token, &content_type, body)
        .await
        .json()
        .await
        .unwrap();
    let file_id = up[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        srv.patch_json_auth(
            &format!("/api/v1/webhooks/{id}"),
            &modr.token,
            json!({ "avatar_file_id": file_id }),
        )
        .await
        .status(),
        200
    );
    let gone = srv
        .delete_json_auth(
            "/api/v1/users/@me",
            &modr.token,
            json!({ "password": "password123", "username": "hookpicmod" }),
        )
        .await;
    assert_eq!(gone.status(), 204);

    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let uploader: Option<String> = sqlx::query_scalar("SELECT uploader_id FROM files WHERE id = ?")
        .bind(&file_id)
        .fetch_optional(&db)
        .await
        .unwrap()
        .flatten();
    assert_eq!(
        uploader.as_deref(),
        Some(owner.id.as_str()),
        "the space's owner keeps it"
    );
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": "still here" }))
            .await
            .status(),
        204
    );
}

#[tokio::test]
async fn webhook_changes_show_in_the_moderation_log_and_who_made_it() {
    let srv = start().await;
    let owner = srv.register("hooklog", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, _token) = made(&srv, &owner, &sp.general, "Logged").await;
    let list: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{}/webhooks", sp.general),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["created_by"], owner.id);
    assert_eq!(list[0]["created_by_name"], "hooklog");
    srv.post_json_auth(
        &format!("/api/v1/webhooks/{id}/token"),
        &owner.token,
        json!({}),
    )
    .await;
    srv.delete_auth(&format!("/api/v1/webhooks/{id}"), &owner.token)
        .await;
    let log: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/moderation-actions", sp.id),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let actions: Vec<&str> = log
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["target_type"] == "webhook" && a["target_id"] == id)
        .map(|a| a["action"].as_str().unwrap())
        .collect();
    for wanted in ["webhook_create", "webhook_renew", "webhook_delete"] {
        assert!(actions.contains(&wanted), "{wanted} is logged: {actions:?}");
    }
}

#[tokio::test]
async fn defused_mentions_count_toward_the_length_limit() {
    let srv = start().await;
    let owner = srv.register("hooklength", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "CI").await;
    let content = "@here ".repeat(666); // 3996 bytes before, 5994 once each is defused
    assert_eq!(
        execute(&srv, &id, &token, json!({ "content": content }))
            .await
            .status(),
        400
    );
}

#[tokio::test]
async fn a_reply_to_a_webhook_says_it_was_an_app() {
    let srv = start().await;
    let owner = srv.register("hookreply", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    let (id, token) = made(&srv, &owner, &sp.general, "Deploy bot").await;
    let posted: Value = srv
        .client
        .post(srv.url(&format!("/api/v1/webhooks/{id}/{token}?wait=true")))
        .json(&json!({ "content": "deployed" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let reply: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/messages", sp.general),
            &owner.token,
            json!({ "content": "nice", "reply_to": posted["id"] }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(reply["reply_to"]["author"], "Deploy bot");
    assert_eq!(reply["reply_to"]["bot"], true);
}

#[tokio::test]
async fn a_webhook_cannot_wake_someone_through_a_mute_by_naming_them() {
    let srv = start().await;
    let owner = srv.register("hookpushowner", "password123").await;
    let member = srv.register("hookpushmember", "password123").await;
    let sp = space(&srv, &owner, "Hooks").await;
    join(&srv, &owner, &sp, &member).await;
    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &member.token,
            json!({ "platform": "web", "endpoint": ENDPOINT, "p256dh": "p256dh-key", "auth": "auth-key", "device_name": "Phone" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let res = srv
        .put_json_auth(
            &format!(
                "/api/v1/users/@me/notification-settings/channel/{}",
                sp.general
            ),
            &member.token,
            json!({ "muted": true }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let (id, token) = made(&srv, &owner, &sp.general, "Pager").await;
    assert_eq!(
        execute(
            &srv,
            &id,
            &token,
            json!({ "content": "@hookpushmember wake up" })
        )
        .await
        .status(),
        204
    );
    let db = SqlitePool::connect(srv.db_url()).await.unwrap();
    let nudges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE user_id = ?")
        .bind(&member.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(nudges, 0, "a webhook's @name doesn't get through a mute");
}
