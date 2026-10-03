//! S-H3: the gateway `Ready` snapshot must apply View Channel exactly like REST does.
//! A channel the member cannot see must not appear in `Ready` (name/topic), and its
//! unread count must not leak through the `unread` map either.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

const VIEW_CHANNEL: i64 = 1 << 6;
const SEND_MESSAGES: i64 = 1 << 7;

#[tokio::test]
async fn ready_omits_channels_and_unreads_the_member_cannot_view() {
    let srv = TestServer::start().await;
    let owner = srv.register("readyowner", "supersecret123").await;
    let member = srv.register("readymember", "supersecret123").await;

    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Ready" }))
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

    let hidden: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &owner.token,
            json!({ "name": "staff-only", "topic": "layoffs" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let hidden_id = hidden["id"].as_str().unwrap().to_owned();

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hidden', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&server_id)
    .bind(&hidden_id)
    .bind(VIEW_CHANNEL | SEND_MESSAGES)
    .execute(&db)
    .await
    .unwrap();

    // One unread message in each channel, authored by the owner.
    for channel_id in [&general_id, &hidden_id] {
        assert_eq!(
            srv.post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &owner.token,
                json!({ "content": "unread for the member" }),
            )
            .await
            .status(),
            200
        );
    }

    let mut gw = Gateway::connect(&srv, &member.token).await;
    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;

    let servers = ready["d"]["servers"].as_array().unwrap();
    let ready_server = servers
        .iter()
        .find(|s| s["id"] == server_id)
        .expect("member's server is in Ready");
    let channel_ids: Vec<&str> = ready_server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(
        channel_ids.contains(&general_id.as_str()),
        "visible channel is listed"
    );
    assert!(
        !channel_ids.contains(&hidden_id.as_str()),
        "hidden channel must not be listed in Ready"
    );

    let unread = ready["d"]["unread"].as_object().unwrap();
    assert_eq!(unread.get(&general_id), Some(&json!(1)));
    assert!(
        !unread.contains_key(&hidden_id),
        "hidden channel's unread count must not be in Ready"
    );
}
